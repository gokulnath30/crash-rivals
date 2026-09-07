import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  setDoc,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore';
import type { SeatIndex } from '@domain/lobby/match.ts';
import type { MatchId } from '@domain/shared/ids.ts';
import { fail, ok, type Result } from '@domain/shared/result.ts';
import type { LoggerPort } from '@app/ports/logger.port.ts';
import type {
  IceCandidate,
  SessionDescription,
  SignalRole,
  SignalingPort,
} from '@app/ports/signaling.port.ts';
import type { Listener, Unsubscribe } from '@app/ports/types.ts';
import { COLLECTIONS } from './firebase-app.ts';
import { describeFirestoreError } from './firestore-errors.ts';

/**
 * The WebRTC handshake, carried on two documents and two small collections per
 * pair of players:
 *
 *   matches/{code}/signals/s2-offer            <- the host's description
 *   matches/{code}/signals/s2-answer           <- seat 2's description
 *   matches/{code}/signals/s2-host/candidates/*
 *   matches/{code}/signals/s2-guest/candidates/*
 *
 * The `s2` is the guest's seat. A four-player room is a star — the host holds a
 * separate connection to each guest — so the host is running up to three of
 * these handshakes simultaneously and each needs its own documents. Sharing one
 * `offer` between them would have three descriptions overwrite each other and
 * nobody would connect.
 *
 * Candidates are separate documents rather than an array because they trickle
 * in from both sides at once, and two clients appending to one array would
 * overwrite each other.
 */
export class FirestoreSignaling implements SignalingPort {
  private readonly log: LoggerPort;

  constructor(
    private readonly db: Firestore,
    logger: LoggerPort,
  ) {
    this.log = logger.scoped('signaling');
  }

  async publishOffer(input: {
    matchId: MatchId;
    seat: SeatIndex;
    description: SessionDescription;
  }): Promise<Result<void>> {
    return this.publish(input.matchId, input.seat, 'offer', input.description);
  }

  async publishAnswer(input: {
    matchId: MatchId;
    seat: SeatIndex;
    description: SessionDescription;
  }): Promise<Result<void>> {
    return this.publish(input.matchId, input.seat, 'answer', input.description);
  }

  observeOffer(
    input: { matchId: MatchId; seat: SeatIndex },
    listener: Listener<SessionDescription>,
  ): Unsubscribe {
    return this.observeDescription(input.matchId, input.seat, 'offer', listener);
  }

  observeAnswer(
    input: { matchId: MatchId; seat: SeatIndex },
    listener: Listener<SessionDescription>,
  ): Unsubscribe {
    return this.observeDescription(input.matchId, input.seat, 'answer', listener);
  }

  async addCandidate(input: {
    matchId: MatchId;
    seat: SeatIndex;
    from: SignalRole;
    candidate: IceCandidate;
  }): Promise<void> {
    try {
      await addDoc(this.candidatesRef(input.matchId, input.seat, input.from), {
        candidate: input.candidate.candidate,
        sdpMid: input.candidate.sdpMid,
        sdpMLineIndex: input.candidate.sdpMLineIndex,
      });
    } catch (error: unknown) {
      // One candidate is one route, but a *rule* rejecting them rejects all of
      // them, and the connection then fails for reasons nothing else reports.
      // Loud enough to see in a production console.
      this.log.log('warn', 'could not publish an ICE candidate', error);
    }
  }

  observeCandidates(
    input: { matchId: MatchId; seat: SeatIndex; from: SignalRole },
    listener: Listener<IceCandidate>,
  ): Unsubscribe {
    return onSnapshot(
      this.candidatesRef(input.matchId, input.seat, input.from),
      (snapshot) => {
        // Only added documents matter: candidates are never edited, and
        // replaying the whole set on every change would re-add each one.
        for (const change of snapshot.docChanges()) {
          if (change.type !== 'added') continue;
          const candidate = toCandidate(change.doc.data());
          if (candidate) listener(candidate);
        }
      },
      (error: unknown) => {
        this.log.log('warn', 'candidate subscription failed', error);
      },
    );
  }

  /**
   * Deletes the handshake once the peers are talking directly. Best effort:
   * leftover signal documents are harmless, and the match document's own
   * lifecycle is what actually matters.
   */
  async clear(input: { matchId: MatchId; seat: SeatIndex }): Promise<void> {
    const { matchId, seat } = input;
    try {
      for (const role of ['host', 'guest'] as const) {
        const candidates = await getDocs(this.candidatesRef(matchId, seat, role));
        await Promise.all(candidates.docs.map((entry) => deleteDoc(entry.ref)));
      }
      await Promise.all(
        (['offer', 'answer'] as const).map((kind) =>
          deleteDoc(
            doc(this.db, COLLECTIONS.matches, matchId, COLLECTIONS.signals, pairDoc(seat, kind)),
          ),
        ),
      );
    } catch (error: unknown) {
      this.log.log('debug', 'could not tidy up the handshake', error);
    }
  }

  private async publish(
    matchId: MatchId,
    seat: SeatIndex,
    kind: 'offer' | 'answer',
    description: SessionDescription,
  ): Promise<Result<void>> {
    try {
      await setDoc(
        doc(this.db, COLLECTIONS.matches, matchId, COLLECTIONS.signals, pairDoc(seat, kind)),
        {
          type: description.type,
          sdp: description.sdp,
          at: Date.now(),
        },
      );
      return ok(undefined);
    } catch (error: unknown) {
      this.log.log('warn', `could not publish the ${kind}`, error);
      return fail(describeFirestoreError(error, 'set up the connection'));
    }
  }

  private observeDescription(
    matchId: MatchId,
    seat: SeatIndex,
    kind: 'offer' | 'answer',
    listener: Listener<SessionDescription>,
  ): Unsubscribe {
    return onSnapshot(
      doc(this.db, COLLECTIONS.matches, matchId, COLLECTIONS.signals, pairDoc(seat, kind)),
      (snapshot) => {
        if (!snapshot.exists()) return;
        const description = toDescription(snapshot.data());
        if (description) listener(description);
      },
      (error: unknown) => {
        this.log.log('warn', `${kind} subscription failed`, error);
      },
    );
  }

  private candidatesRef(matchId: MatchId, seat: SeatIndex, role: SignalRole) {
    return collection(
      this.db,
      COLLECTIONS.matches,
      matchId,
      COLLECTIONS.signals,
      pairDoc(seat, role),
      'candidates',
    );
  }
}

/**
 * Names one document in one pair's handshake.
 *
 * Everything about a pair is prefixed with the guest's seat, so the host's
 * three simultaneous handshakes never touch the same document. One function
 * because a prefix that is built in five places gets typed differently in one
 * of them, and the read side then silently watches a document nobody writes.
 */
const pairDoc = (seat: SeatIndex, kind: 'offer' | 'answer' | SignalRole): string =>
  `s${seat}-${kind}`;

function toDescription(data: DocumentData): SessionDescription | null {
  // `DocumentData` indexes to `any`, so it is narrowed to unknown here and
  // every field is checked rather than trusted.
  const fields = data as Readonly<Record<string, unknown>>;
  const type = fields['type'];
  const sdp = fields['sdp'];
  if ((type !== 'offer' && type !== 'answer') || typeof sdp !== 'string') return null;
  return { type, sdp };
}

function toCandidate(data: DocumentData): IceCandidate | null {
  const fields = data as Readonly<Record<string, unknown>>;
  const candidate = fields['candidate'];
  const sdpMid = fields['sdpMid'];
  const sdpMLineIndex = fields['sdpMLineIndex'];
  if (typeof candidate !== 'string') return null;
  return {
    candidate,
    sdpMid: typeof sdpMid === 'string' ? sdpMid : null,
    sdpMLineIndex: typeof sdpMLineIndex === 'number' ? sdpMLineIndex : null,
  };
}
