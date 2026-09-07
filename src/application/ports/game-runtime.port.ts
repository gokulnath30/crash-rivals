import type { GameMode } from '@domain/catalog/game-definition.ts';
import { HOST_SEAT, type Match, type SeatIndex } from '@domain/lobby/match.ts';
import type { GameId } from '@domain/shared/ids.ts';
import type { Result } from '@domain/shared/result.ts';
import type { AudioPort } from './audio.port.ts';
import type { ClockPort } from './clock.port.ts';
import type { LoggerPort } from './logger.port.ts';
import type { Channel, PeerLinkPort } from './peer-link.port.ts';

/** What an online game is handed once the players are connected. */
export interface OnlineSession {
  readonly match: Match;
  /** Which seat this browser is playing. 0 hosts and is authoritative. */
  readonly seat: SeatIndex;
  /**
   * One link per peer this browser talks to, keyed by that peer's seat.
   *
   * The host has one entry per guest; a guest has exactly one, to the host.
   * Nobody has an entry for themselves. This is a map rather than a single
   * link because the room is a star and only the centre of it has more than
   * one edge — a guest that tried to reach another guest directly would need a
   * second handshake nothing has set up.
   */
  readonly links: ReadonlyMap<SeatIndex, PeerLinkPort>;
}

/**
 * Sends on every link at once — how the host broadcasts to a whole room.
 *
 * Failure to reach one peer is deliberately not failure to reach the rest: a
 * guest whose connection has died must not stop the others from getting the
 * next frame of the race.
 */
export function broadcast(
  session: OnlineSession,
  channel: Channel,
  data: ArrayBuffer | string,
): void {
  for (const link of session.links.values()) link.send(channel, data);
}

/** The one link a guest has: to the host. Null for the host itself. */
export const linkToHost = (session: OnlineSession): PeerLinkPort | null =>
  session.links.get(HOST_SEAT) ?? null;

/** Everything a game is given, and nothing it has to go looking for. */
export interface GameContext {
  readonly mode: GameMode;
  /** The element to render into. The game owns its contents. */
  readonly mount: HTMLElement;
  readonly audio: AudioPort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
  /** Set only for `online-versus`. */
  readonly online: OnlineSession | null;
  /** Names to put on the health bars. */
  readonly labels: { readonly self: string; readonly opponent: string };
  /** The game calls this to hand control back to the store. */
  readonly exit: () => void;
}

export interface GameHandle {
  /** Tears down loops, listeners, WebGL contexts and camera streams. */
  stop(): void;
}

export interface GameRuntime {
  readonly id: GameId;
  launch(context: GameContext): Promise<Result<GameHandle>>;
}

/**
 * Resolves a catalogue entry to something playable.
 *
 * Separate from `GameCatalogPort` so the store can list twelve games while
 * downloading the code for none of them: the registry loads a game's module
 * only when someone actually presses play.
 */
export interface GameRegistryPort {
  load(id: GameId): Promise<Result<GameRuntime>>;
}
