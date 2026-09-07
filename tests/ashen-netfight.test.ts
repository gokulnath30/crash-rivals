import { describe, expect, it } from 'vitest';
import { IDLE_INTENT, type Intent } from '@domain/arena/brawler.ts';
import { Fight } from '@domain/arena/fight.ts';
import { captureFight } from '@domain/arena/snapshot.ts';
import type {
  Channel,
  LinkDiagnostics,
  LinkState,
  PeerLinkPort,
  PeerPayload,
} from '@app/ports/peer-link.port.ts';
import type { Listener, Unsubscribe } from '@app/ports/types.ts';
import { NetFight } from '@games/ashen-ring/netcode/net-fight.ts';
import { SilentLogger } from './support/fakes.ts';

/**
 * The two ends of an online fight, wired to each other through a pair of fake
 * links. No browser and no network: just the question of whether a host and a
 * guest say the right things to each other, on the right channels.
 */
class FakeLink implements PeerLinkPort {
  state: LinkState = 'open';
  role = null;
  latencyMs: number | null = 42;
  diagnostics: LinkDiagnostics = {
    localCandidateTypes: [],
    remoteCandidates: 0,
    turnConfigured: false,
    gotRemoteDescription: true,
    iceConnectionState: 'connected',
  };

  /** Everything this end has sent, in order. */
  readonly sent: PeerPayload[] = [];
  /** The link at the other end, if these have been joined up. */
  private peer: FakeLink | null = null;
  private readonly dataListeners = new Set<Listener<PeerPayload>>();

  /** Joins two links so that what one sends, the other receives. */
  static pair(): [FakeLink, FakeLink] {
    const a = new FakeLink();
    const b = new FakeLink();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  async openAsHost(): Promise<never> {
    throw new Error('not used');
  }

  async openAsGuest(): Promise<never> {
    throw new Error('not used');
  }

  send(channel: Channel, data: ArrayBuffer | string): void {
    const payload: PeerPayload = { channel, data };
    this.sent.push(payload);
    this.peer?.deliver(payload);
  }

  onData(listener: Listener<PeerPayload>): Unsubscribe {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onStateChange(): Unsubscribe {
    return () => undefined;
  }

  attachLocalMedia(): void {}
  onRemoteMedia(): Unsubscribe {
    return () => undefined;
  }
  setMicrophoneMuted(): void {}
  setCameraMuted(): void {}
  close(): void {
    this.state = 'closed';
  }

  private deliver(payload: PeerPayload): void {
    for (const listener of this.dataListeners) listener(payload);
  }
}

const logger = new SilentLogger();
const press = (partial: Partial<Intent>): Intent => ({ ...IDLE_INTENT, ...partial });

/** A host and guest, already connected to each other. */
function connected(): { host: NetFight; guest: NetFight; hostLink: FakeLink; guestLink: FakeLink } {
  const [hostLink, guestLink] = FakeLink.pair();
  return {
    hostLink,
    guestLink,
    host: new NetFight(hostLink, true, logger),
    guest: new NetFight(guestLink, false, logger),
  };
}

/** Enough time that a rationed send is allowed through. */
const A_WHILE = 1;

describe('a host and a guest', () => {
  it('sends the guest controls to the host, and nowhere else', () => {
    const { host, guest } = connected();
    guest.publishIntent(press({ punch: true, move: 1 }), A_WHILE);
    expect(host.remoteIntent()).toEqual(press({ punch: true, move: 1 }));
    // The host never has a "remote intent" to give back to the guest.
    expect(guest.remoteIntent()).toBeNull();
  });

  it('sends the fight itself from the host to the guest', () => {
    const { host, guest } = connected();
    const fight = new Fight(['HOST', 'GUEST']);
    fight.start();
    host.publishState(captureFight(fight), A_WHILE);

    const state = guest.takeState();
    expect(state?.phase).toBe('intro');
    expect(state?.brawlers[0].x).toBeCloseTo(fight.brawlers[0].x, 3);
    // Taken once: a snapshot already applied should not be applied again.
    expect(guest.takeState()).toBeNull();
  });

  it('leaves the last known input standing when nothing new arrives', () => {
    const { host, guest } = connected();
    guest.publishIntent(press({ guard: true }), A_WHILE);
    expect(host.remoteIntent()?.guard).toBe(true);
    // Asked again with nothing new in between, the answer is the same rather
    // than nothing — a dropped packet should not stop the far fighter dead.
    expect(host.remoteIntent()?.guard).toBe(true);
  });

  it('puts the per-frame traffic on the unreliable channel and the rest on the sure one', () => {
    const { host, hostLink, guest, guestLink } = connected();
    host.publishState(captureFight(new Fight(['A', 'B'])), A_WHILE);
    host.send({ t: 'hello', name: 'HOST', pick: 'sable' });
    guest.publishIntent(IDLE_INTENT, A_WHILE);

    expect(hostLink.sent.map((p) => p.channel)).toEqual(['fast', 'sure']);
    expect(guestLink.sent.map((p) => p.channel)).toEqual(['fast']);
  });

  it('rations the per-frame traffic rather than sending every frame', () => {
    const { host, hostLink } = connected();
    const state = captureFight(new Fight(['A', 'B']));
    // A second of frames at 120 fps, against a thirty-a-second budget.
    for (let i = 0; i < 120; i++) host.publishState(state, 1 / 120);
    expect(hostLink.sent.length).toBeGreaterThan(20);
    expect(hostLink.sent.length).toBeLessThanOrEqual(31);
  });

  it('ignores a packet meant for the other end', () => {
    const { host, guest, guestLink } = connected();
    // A guest that sends snapshots is either broken or hostile; either way
    // the host has its own copy of the truth and does not want this one.
    guestLink.send('fast', new ArrayBuffer(57));
    expect(host.remoteIntent()).toBeNull();
    expect(guest.takeState()).toBeNull();
  });

  it('carries the events that must not be lost, whole', () => {
    const { host, guest } = connected();
    const heard: unknown[] = [];
    guest.onMessage((message) => heard.push(message));

    host.sendEvents([
      { kind: 'fight-call' },
      { kind: 'announce', text: 'K.O.', holdMs: 1400 },
    ]);
    expect(heard).toEqual([
      { t: 'fx', events: [{ kind: 'fight-call' }, { kind: 'announce', text: 'K.O.', holdMs: 1400 }] },
    ]);
  });

  it('says nothing at all when there were no events', () => {
    const { host, hostLink } = connected();
    host.sendEvents([]);
    expect(hostLink.sent).toHaveLength(0);
  });

  it('drops a malformed message instead of throwing', () => {
    const { guest, hostLink } = connected();
    const heard: unknown[] = [];
    guest.onMessage((message) => heard.push(message));
    hostLink.send('sure', 'not json at all');
    hostLink.send('sure', JSON.stringify({ t: 'drop-tables' }));
    expect(heard).toHaveLength(0);
  });

  it('reports the round trip, and stops listening once disposed', () => {
    const { guest, hostLink } = connected();
    expect(guest.latencyMs).toBe(42);

    const heard: unknown[] = [];
    guest.onMessage((message) => heard.push(message));
    guest.dispose();
    hostLink.send('sure', JSON.stringify({ t: 'ready' }));
    expect(heard).toHaveLength(0);
  });
});
