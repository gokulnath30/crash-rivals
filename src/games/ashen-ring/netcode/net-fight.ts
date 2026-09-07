import type { Intent } from '@domain/arena/brawler.ts';
import type { ArenaEvent } from '@domain/arena/events.ts';
import type { FightState } from '@domain/arena/snapshot.ts';
import type { LoggerPort } from '@app/ports/logger.port.ts';
import type { PeerLinkPort, PeerPayload } from '@app/ports/peer-link.port.ts';
import type { Unsubscribe } from '@app/ports/types.ts';
import {
  decodeIntent,
  decodeMessage,
  decodeState,
  encodeIntent,
  encodeMessage,
  encodeState,
  type NetMessage,
} from './protocol.ts';

/**
 * The other player, behind one seam.
 *
 * Everything about the connection lives here: which channel a thing goes on,
 * how often the per-frame traffic is allowed to leave, and the fact that
 * anything arriving might be nonsense. The session above it deals in intents,
 * snapshots and events, and never touches a byte.
 */

/** How often the host tells the guest where everything is. */
const SNAPSHOT_HZ = 30;
/** How often the guest tells the host what it is holding. */
const INTENT_HZ = 60;

export class NetFight {
  /** The newest thing to arrive, taken by the session on its own schedule. */
  private latestState: FightState | null = null;
  private latestIntent: Intent | null = null;
  private sinceState = 0;
  private sinceIntent = 0;
  private readonly messageListeners = new Set<(message: NetMessage) => void>();
  private readonly detach: Unsubscribe[] = [];
  private readonly log: LoggerPort;

  constructor(
    private readonly link: PeerLinkPort,
    /** True for seat 0, the browser that runs the rules. */
    readonly isHost: boolean,
    logger: LoggerPort,
  ) {
    this.log = logger.scoped('net-fight');
    this.detach.push(
      link.onData((payload: PeerPayload) => {
        this.receive(payload);
      }),
    );
  }

  get latencyMs(): number | null {
    return this.link.latencyMs;
  }

  /** Sends one of the rare, must-not-be-lost messages. */
  send(message: NetMessage): void {
    this.link.send('sure', encodeMessage(message));
  }

  /** Sends the presentation events the host just produced, if there are any. */
  sendEvents(events: readonly ArenaEvent[]): void {
    if (events.length === 0) return;
    this.send({ t: 'fx', events });
  }

  /**
   * The host's account of the fight, rationed to `SNAPSHOT_HZ`.
   *
   * On the unreliable channel with retransmission off: a snapshot that has
   * been superseded is worse than useless, because it arrives after the one
   * that replaced it and drags the fight backwards.
   */
  publishState(state: FightState, dt: number): void {
    this.sinceState += dt;
    if (this.sinceState < 1 / SNAPSHOT_HZ) return;
    this.sinceState = 0;
    this.link.send('fast', encodeState(state));
  }

  /** The guest's controls, rationed the same way. */
  publishIntent(intent: Intent, dt: number): void {
    this.sinceIntent += dt;
    if (this.sinceIntent < 1 / INTENT_HZ) return;
    this.sinceIntent = 0;
    this.link.send('fast', encodeIntent(intent));
  }

  /** The newest snapshot, or null if none has arrived since last asked. */
  takeState(): FightState | null {
    const state = this.latestState;
    this.latestState = null;
    return state;
  }

  /**
   * What the guest is holding right now.
   *
   * Not cleared when read: the host needs an answer every frame, and a
   * dropped packet should leave the last known input standing rather than
   * making the far fighter twitch to a stop.
   */
  remoteIntent(): Intent | null {
    return this.latestIntent;
  }

  onMessage(listener: (message: NetMessage) => void): Unsubscribe {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  dispose(): void {
    for (const remove of this.detach.splice(0)) remove();
    this.messageListeners.clear();
    this.latestState = null;
    this.latestIntent = null;
  }

  private receive(payload: PeerPayload): void {
    if (payload.channel === 'fast') {
      // Each side only ever accepts the packet it has a use for, so a guest
      // sending snapshots, or a host sending intents, is simply ignored.
      if (this.isHost) {
        const intent = decodeIntent(payload.data);
        if (intent) this.latestIntent = intent;
        return;
      }
      const state = decodeState(payload.data);
      if (state) this.latestState = state;
      return;
    }

    const message = decodeMessage(payload.data);
    if (!message) {
      this.log.log('debug', 'ignored a malformed message');
      return;
    }
    for (const listener of this.messageListeners) listener(message);
  }
}
