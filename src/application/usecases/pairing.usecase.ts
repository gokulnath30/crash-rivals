import type { Session } from '@domain/identity/session.ts';
import {
  canBegin,
  capacityOf,
  guestSeatsOf,
  HOST_SEAT,
  occupantsOf,
  seatAt,
  seatOf,
  type Match,
  type SeatIndex,
} from '@domain/lobby/match.ts';
import { fail, failure, ok, type Result } from '@domain/shared/result.ts';
import type { LoggerPort } from '../ports/logger.port.ts';
import type { OnlineSession } from '../ports/game-runtime.port.ts';
import type { LinkState, PeerLinkFactory, PeerLinkPort } from '../ports/peer-link.port.ts';
import type { Unsubscribe } from '../ports/types.ts';
import type { LobbyService } from './lobby.usecase.ts';

/** How long to wait for the other browser before giving up on the handshake. */
const CONNECT_TIMEOUT_MS = 25_000;

/** One line on the lobby screen: who is here, and can we talk to them yet. */
export interface RosterEntry {
  readonly seat: SeatIndex;
  readonly name: string;
  /** True for the row that is this browser. */
  readonly you: boolean;
  /**
   * Whether a data channel to this player is open.
   *
   * Always true for yourself and, from a guest's point of view, for the host —
   * a guest only ever has the one connection, so anyone else in the room is
   * someone it cannot see the state of.
   */
  readonly connected: boolean;
}

export type PairingStage =
  /** Sitting in the room, waiting for people or for the host to start. */
  | {
      readonly kind: 'waiting';
      readonly code: string;
      readonly roster: readonly RosterEntry[];
      readonly capacity: number;
      /** Whether *this* browser can start the match now. Only ever the host. */
      readonly canStart: boolean;
      /** What this browser is waiting for, in words. */
      readonly note: string;
    }
  | { readonly kind: 'connected'; readonly session: OnlineSession }
  | { readonly kind: 'failed'; readonly message: string };

/** What the lobby screen holds while a room is filling up. */
export interface PairingHandle {
  /**
   * Starts the match. The host's button; a no-op for everyone else, and a
   * no-op until at least one other player is connected.
   */
  start(): void;
  /** Leaves the room and closes every half-open link. */
  cancel(): Unsubscribe;
}

/**
 * Getting a roomful of browsers talking, then getting out of the way.
 *
 * The room document is only ever used to find each other and to swap WebRTC
 * handshakes. Once the data channels are open, frames travel directly between
 * players and this service does nothing further.
 *
 * The shape is a star, not a mesh: every guest connects to the host and to
 * nobody else. That is three connections in a four-player room instead of six,
 * it matches who actually needs to talk to whom — seat 0 simulates and the
 * rest send input — and it means a guest needs one working connection rather
 * than three.
 */
export class PairingService {
  constructor(
    private readonly links: PeerLinkFactory,
    private readonly lobby: LobbyService,
    private readonly logger: LoggerPort,
  ) {}

  /**
   * Host side: hold the room open, dial each guest as they arrive, and wait
   * for the host to press start.
   */
  hostRoom(input: {
    session: Session;
    match: Match;
    onStage: (stage: PairingStage) => void;
  }): PairingHandle {
    const log = this.logger.scoped('pairing');
    const open = new Map<SeatIndex, PeerLinkPort>();
    const dialing = new Set<SeatIndex>();
    let match = input.match;
    let done = false;

    // Declared before the subscription below, not after it: a repository that
    // emits its first value synchronously would otherwise reach this in its
    // temporal dead zone. It is only ever called from inside a callback, by
    // which point the assignment has happened.
    let stopWatching: Unsubscribe = () => undefined;

    const closeAll = (): void => {
      for (const link of open.values()) link.close();
      open.clear();
    };

    const finish = (stage: PairingStage): void => {
      if (done) return;
      done = true;
      stopWatching();
      if (stage.kind !== 'connected') closeAll();
      input.onStage(stage);
    };

    const announce = (): void => {
      if (done) return;
      const connected = open.size;
      input.onStage({
        kind: 'waiting',
        code: match.code,
        roster: rosterFor(match, HOST_SEAT, (seat) => seat === HOST_SEAT || open.has(seat)),
        capacity: capacityOf(match),
        canStart: connected > 0 && canBegin(match),
        note:
          connected > 0
            ? 'Ready when you are. Any empty seat is driven by the machine.'
            : 'Share the code and wait for someone to join.',
      });
    };

    /** Dials one guest. Failing to reach them leaves the rest of the room alone. */
    const dial = (seat: SeatIndex): void => {
      if (done || open.has(seat) || dialing.has(seat)) return;
      dialing.add(seat);
      log.log('info', 'a guest arrived, offering a connection', { code: match.code, seat });

      const link = this.links();
      void this.openAndAwait(link, () => link.openAsHost(match, seat)).then((opened) => {
        dialing.delete(seat);
        if (done) {
          link.close();
          return;
        }
        if (!opened.ok) {
          // One guest failing to connect is not the room failing. Their seat
          // stays occupied but unreachable, the host can still start, and the
          // game fills it the same way it fills an empty one.
          log.log('warn', 'could not reach a guest', { seat, why: opened.error.message });
          link.close();
          announce();
          return;
        }
        open.set(seat, link);
        announce();
      });
    };

    announce();

    stopWatching = this.lobby.observe(input.match, (updated) => {
      if (done) return;
      if (!updated) {
        finish({ kind: 'failed', message: 'The room disappeared. Open a new one.' });
        return;
      }
      if (updated.status === 'abandoned') {
        finish({ kind: 'failed', message: 'That room was closed.' });
        return;
      }
      match = updated;
      for (const seat of guestSeatsOf(updated)) dial(seat);
      announce();
    });

    return {
      start: () => {
        if (done || open.size === 0) return;
        // The room is only marked live once the peers can actually talk, so a
        // failed handshake leaves the code joinable for a retry.
        void this.lobby.start(match).then((started) => {
          if (done) return;
          const live = started.ok ? started.value : match;
          finish({
            kind: 'connected',
            session: { match: live, seat: HOST_SEAT, links: new Map(open) },
          });
        });
      },
      cancel: () => {
        if (!done) {
          done = true;
          stopWatching();
          closeAll();
        }
        return () => undefined;
      },
    };
  }

  /**
   * Guest side: answer the host's offer, then wait for them to start.
   *
   * The guest has already been seated by `LobbyService.join` before this runs.
   */
  joinRoom(input: {
    session: Session;
    match: Match;
    onStage: (stage: PairingStage) => void;
  }): PairingHandle {
    const mySeat = seatOf(input.match, input.session.player.id);
    if (mySeat === null || mySeat === HOST_SEAT) {
      input.onStage({ kind: 'failed', message: 'You are not a guest in that room.' });
      return { start: () => undefined, cancel: () => () => undefined };
    }

    const seat = mySeat;
    let match = input.match;
    let link: PeerLinkPort | null = null;
    let linked = false;
    let done = false;
    let stopWatching: Unsubscribe = () => undefined;

    const finish = (stage: PairingStage): void => {
      if (done) return;
      done = true;
      stopWatching();
      if (stage.kind !== 'connected') link?.close();
      input.onStage(stage);
    };

    const announce = (): void => {
      if (done) return;
      input.onStage({
        kind: 'waiting',
        code: match.code,
        // A guest can only vouch for the one connection it holds. Whether seat
        // 3 has reached the host is something only the host knows, so the rows
        // for other guests say "here", not "connected".
        roster: rosterFor(match, seat, (row) => row === seat || (row === HOST_SEAT && linked)),
        capacity: capacityOf(match),
        canStart: false,
        note: linked
          ? 'Connected. Waiting for the host to start.'
          : 'Connecting to the host…',
      });
    };

    announce();

    const opening = this.links();
    link = opening;
    void this.openAndAwait(opening, () => opening.openAsGuest(match, seat)).then((opened) => {
      if (done) return;
      if (!opened.ok) {
        finish({ kind: 'failed', message: opened.error.message });
        return;
      }
      linked = true;
      announce();
      // The host may already have started between the handshake beginning and
      // it completing, so this is checked rather than only waited for.
      if (match.status === 'live') begin();
    });

    const begin = (): void => {
      if (!linked) return;
      const host = opening;
      finish({
        kind: 'connected',
        session: { match, seat, links: new Map([[HOST_SEAT, host]]) },
      });
    };

    stopWatching = this.lobby.observe(input.match, (updated) => {
      if (done) return;
      if (!updated) {
        finish({ kind: 'failed', message: 'The room disappeared.' });
        return;
      }
      if (updated.status === 'abandoned') {
        finish({ kind: 'failed', message: 'The host closed that room.' });
        return;
      }
      match = updated;
      if (updated.status === 'live') {
        begin();
        return;
      }
      announce();
    });

    return {
      start: () => undefined,
      cancel: () => {
        if (!done) {
          done = true;
          stopWatching();
          opening.close();
        }
        return () => undefined;
      },
    };
  }

  /**
   * Runs one side of one handshake and waits for the data channels to open,
   * failing cleanly on timeout rather than hanging on a lobby screen forever.
   */
  private async openAndAwait(
    link: PeerLinkPort,
    open: () => Promise<Result<void>>,
  ): Promise<Result<void>> {
    return Promise.race([this.awaitOpen(link), open().then(passThroughFailure)]);
  }

  private awaitOpen(link: PeerLinkPort): Promise<Result<void>> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: Result<void>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stop();
        resolve(result);
      };

      const timer = setTimeout(() => {
        settle(fail(failure('transport-failed', describeStall(link))));
      }, CONNECT_TIMEOUT_MS);

      const stop = link.onStateChange((state: LinkState) => {
        if (state === 'open') settle(ok(undefined));
        if (state === 'failed' || state === 'closed') {
          settle(fail(failure('transport-failed', describeStall(link))));
        }
      });

      if (link.state === 'open') settle(ok(undefined));
    });
  }
}

/**
 * Builds the lobby's roster.
 *
 * `isConnected` is passed in rather than read off the links, because host and
 * guest genuinely know different things: the host can see every connection, a
 * guest can only see its own.
 */
function rosterFor(
  match: Match,
  me: SeatIndex,
  isConnected: (seat: SeatIndex) => boolean,
): readonly RosterEntry[] {
  const rows: RosterEntry[] = [];
  match.seats.forEach((occupant, seat) => {
    if (!occupant) return;
    rows.push({
      seat,
      name: occupant.displayName,
      you: seat === me,
      connected: isConnected(seat),
    });
  });
  return rows;
}

/** Turns a failed open into the same shape a state change would produce. */
const passThroughFailure = (result: Result<void>): Result<void> =>
  result.ok ? { ok: true, value: undefined } : result;

/**
 * Says why a handshake did not happen, using what the link actually gathered.
 *
 * "The connection dropped during setup" is true of every failure here and
 * useless for all of them. Each branch below names a different cause with a
 * different fix — a blocked STUN server, a NAT that needs a relay, and a
 * friend who closed the tab are three problems, not one — and the browser
 * already knows which one it hit, so the message says.
 */
function describeStall(link: PeerLinkPort): string {
  const seen = link.diagnostics;

  if (!seen.gotRemoteDescription) {
    return (
      'The other player never answered. They may have closed the connection or ' +
      'never opened the link — ask them to open it again.'
    );
  }

  // No server-reflexive and no relay candidate means this browser never
  // discovered its own public address, so STUN did not get through.
  const reachedStun =
    seen.localCandidateTypes.includes('srflx') || seen.localCandidateTypes.includes('relay');
  if (!reachedStun) {
    return (
      'This network blocked STUN, so the browser could not work out its own public ' +
      'address. A firewall or VPN is the usual cause.'
    );
  }

  if (!seen.turnConfigured) {
    return (
      'Both of you were reachable but no direct path could be agreed, which needs a ' +
      'TURN relay to get around. None is configured for this arcade — see README.md. ' +
      'This is common on mobile data.'
    );
  }

  return (
    'No route could be found between your two networks, even through the relay. ' +
    'Try again, or one of you on a different connection.'
  );
}

/** Exported for the lobby screen, which lists who is present. */
export const rosterOf = (match: Match): readonly string[] =>
  occupantsOf(match).map((seat) => seat.displayName);

/** Exported so the lobby can show "Seat 3 — empty" rows. */
export const emptySeatsOf = (match: Match): readonly SeatIndex[] => {
  const empty: SeatIndex[] = [];
  match.seats.forEach((occupant, seat) => {
    if (!occupant) empty.push(seat);
  });
  return empty;
};

/** Re-exported for callers that only need the name in a seat. */
export { seatAt };
