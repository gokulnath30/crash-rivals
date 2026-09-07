import {
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  setDoc,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore';
import type { InviteCode } from '@domain/lobby/invite-code.ts';
import { isInviteCode } from '@domain/lobby/invite-code.ts';
import {
  isStale,
  type Match,
  type MatchStatus,
  type Seat,
  type SeatIndex,
  HOST_SEAT,
  MAX_SEATS,
  MIN_TO_BEGIN,
  occupantsOf,
} from '@domain/lobby/match.ts';
import { asGameId, asMatchId, asPlayerId, type MatchId } from '@domain/shared/ids.ts';
import { fail, failure, ok, type Result } from '@domain/shared/result.ts';
import type { LoggerPort } from '@app/ports/logger.port.ts';
import type { MatchRepositoryPort } from '@app/ports/match-repository.port.ts';
import type { Listener, Unsubscribe } from '@app/ports/types.ts';
import { COLLECTIONS } from './firebase-app.ts';
import { describeFirestoreError } from './firestore-errors.ts';

/**
 * Rooms in Firestore, one document per invite code.
 *
 * The invite code is the document id, which buys three things: looking a room
 * up by code is a single read, reserving a code is atomic, and no query index
 * is needed anywhere in the app.
 */
export class FirestoreMatchRepository implements MatchRepositoryPort {
  private readonly log: LoggerPort;

  constructor(
    private readonly db: Firestore,
    logger: LoggerPort,
  ) {
    this.log = logger.scoped('matches');
  }

  /**
   * Reserves a code, in a transaction so that two simultaneous "create a
   * room" taps cannot both win.
   *
   * A code whose previous room is finished, abandoned or long stale is fair
   * game to take over — otherwise every dead lobby would burn a code forever.
   */
  async create(match: Match): Promise<Result<Match>> {
    const ref = doc(this.db, COLLECTIONS.matches, match.code);
    try {
      await runTransaction(this.db, async (tx) => {
        const existing = await tx.get(ref);
        if (existing.exists()) {
          const current = toMatch(existing.id, existing.data());
          const reusable =
            current === null ||
            current.status === 'abandoned' ||
            current.status === 'finished' ||
            isStale(current, Date.now());
          if (!reusable) throw new CodeTakenError();
        }
        tx.set(ref, toDocument(match));
      });
      return ok(match);
    } catch (error: unknown) {
      if (error instanceof CodeTakenError) {
        // A distinct code, so the caller can roll again instead of treating
        // a collision as a database outage.
        return fail(failure('code-taken', 'That room code is in use.'));
      }
      this.log.log('warn', 'could not open a room', error);
      return fail(describeFirestoreError(error, 'open a room'));
    }
  }

  async find(id: MatchId): Promise<Result<Match | null>> {
    return this.readDocument(id);
  }

  async findByCode(code: InviteCode): Promise<Result<Match | null>> {
    // Code and id are the same string by construction.
    return this.readDocument(asMatchId(code));
  }

  async save(match: Match): Promise<Result<Match>> {
    try {
      await setDoc(doc(this.db, COLLECTIONS.matches, match.code), toDocument(match));
      return ok(match);
    } catch (error: unknown) {
      this.log.log('warn', 'could not save the room', error);
      return fail(describeFirestoreError(error, 'update the room'));
    }
  }

  observe(id: MatchId, listener: Listener<Match | null>): Unsubscribe {
    return onSnapshot(
      doc(this.db, COLLECTIONS.matches, id),
      (snapshot) => {
        listener(snapshot.exists() ? toMatch(snapshot.id, snapshot.data()) : null);
      },
      (error: unknown) => {
        this.log.log('warn', 'room subscription failed', error);
        listener(null);
      },
    );
  }

  private async readDocument(id: MatchId): Promise<Result<Match | null>> {
    try {
      const snapshot = await getDoc(doc(this.db, COLLECTIONS.matches, id));
      return ok(snapshot.exists() ? toMatch(snapshot.id, snapshot.data()) : null);
    } catch (error: unknown) {
      this.log.log('warn', 'could not read the room', error);
      return fail(describeFirestoreError(error, 'find that room'));
    }
  }
}

class CodeTakenError extends Error {
  constructor() {
    super('invite code already in use');
    this.name = 'CodeTakenError';
  }
}

function toDocument(match: Match): DocumentData {
  return {
    code: match.code,
    gameId: match.gameId,
    /*
     * Seats go out as a fixed-length array with holes written as `null`.
     *
     * Firestore has no sparse arrays, so an empty seat has to be *something* —
     * and it has to be a placeholder rather than a shorter array, because the
     * array's length is what tells a reader how many seats the room has. Drop
     * the holes and a room of four with one guest reads back as a room of two.
     */
    seats: match.seats.map((seat) => (seat ? seatToDocument(seat) : null)),
    // Denormalised so the security rules can check membership without
    // reaching into nested maps.
    playerIds: occupantsOf(match).map((seat) => seat.playerId),
    status: match.status,
    winner: match.winner,
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
  };
}

const seatToDocument = (seat: Seat): DocumentData => ({
  playerId: seat.playerId,
  displayName: seat.displayName,
  avatarUrl: seat.avatarUrl,
});

/**
 * Parses a room document defensively. Anything malformed reads as "no room",
 * because a lobby that crashes on a bad document is worse than one that says
 * the code is not in use.
 */
function toMatch(id: string, data: DocumentData): Match | null {
  if (!isInviteCode(id)) return null;
  const seats = toSeats(data['seats']);
  // Seat 0 holds the host. No host, no room — the same rule the constructors
  // enforce, applied to whatever the database happened to hand back.
  if (!seats || !seats[HOST_SEAT]) return null;

  return {
    id: asMatchId(id),
    code: id,
    gameId: asGameId(asString(data['gameId'], 'unknown')),
    seats,
    status: toStatus(data['status']),
    winner: toSeatIndex(data['winner'], seats.length),
    createdAt: asNumber(data['createdAt']),
    updatedAt: asNumber(data['updatedAt']),
  };
}

function toSeats(value: unknown): (Seat | null)[] | null {
  if (!Array.isArray(value)) return null;
  const capacity = Math.max(MIN_TO_BEGIN, Math.min(MAX_SEATS, value.length));
  const seats: (Seat | null)[] = new Array<Seat | null>(capacity).fill(null);
  for (let index = 0; index < capacity; index += 1) seats[index] = toSeat(value[index]);
  return seats;
}

function toSeat(value: unknown): Seat | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const playerId = raw['playerId'];
  if (typeof playerId !== 'string' || playerId.length === 0) return null;
  return {
    playerId: asPlayerId(playerId),
    displayName: asString(raw['displayName'], 'Player'),
    avatarUrl: typeof raw['avatarUrl'] === 'string' ? raw['avatarUrl'] : null,
  };
}

const STATUSES: readonly MatchStatus[] = ['open', 'ready', 'live', 'finished', 'abandoned'];

function toStatus(value: unknown): MatchStatus {
  return STATUSES.find((status) => status === value) ?? 'abandoned';
}

function toSeatIndex(value: unknown, capacity: number): SeatIndex | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= 0 && value < capacity ? value : null;
}

const asString = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback;

const asNumber = (value: unknown): number => (typeof value === 'number' ? value : 0);
