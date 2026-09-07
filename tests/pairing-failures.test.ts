import { describe, expect, it } from 'vitest';
import { asGameId, asMatchId, asPlayerId } from '@domain/shared/ids.ts';
import type { InviteCode } from '@domain/lobby/invite-code.ts';
import type { Match } from '@domain/lobby/match.ts';
import { ok, type Result } from '@domain/shared/result.ts';
import type {
  Channel,
  LinkDiagnostics,
  LinkState,
  PeerLinkPort,
  PeerPayload,
} from '@app/ports/peer-link.port.ts';
import type { SignalRole } from '@app/ports/signaling.port.ts';
import type { Listener, Unsubscribe } from '@app/ports/types.ts';
import { PairingService } from '@app/usecases/pairing.usecase.ts';
import { LobbyService } from '@app/usecases/lobby.usecase.ts';
import {
  FakeCatalog,
  FakeClock,
  FakeMatchRepository,
  FakeShare,
  SilentLogger,
  testPlayer,
} from './support/fakes.ts';

/**
 * What a failed connection tells the player.
 *
 * "The connection dropped during setup" is true of every failure here and
 * useful for none of them: a blocked STUN server, a NAT that needs a relay and
 * a friend who closed the tab need three different responses. The browser
 * already knows which one it hit, so the message should say.
 */

const CODE = 'SAGS' as InviteCode;

const MATCH: Match = {
  id: asMatchId(CODE),
  code: CODE,
  gameId: asGameId('ashen-ring'),
  seats: [
    { playerId: asPlayerId('host'), displayName: 'Host', avatarUrl: null },
    { playerId: asPlayerId('guest'), displayName: 'Guest', avatarUrl: null },
  ],
  status: 'ready',
  winner: null,
  createdAt: 0,
  updatedAt: 0,
};

const SESSION = {
  player: testPlayer({ id: asPlayerId('guest'), email: 'guest@example.com' }),
  grant: { email: 'guest@example.com', role: 'player' as const, note: null, grantedAt: 0 },
};

/** A link that fails immediately, reporting whatever diagnostics the test sets. */
class FailingLink implements PeerLinkPort {
  state: LinkState = 'idle';
  role: SignalRole | null = 'guest';
  latencyMs = null;

  private listeners: Listener<LinkState>[] = [];

  constructor(public diagnostics: LinkDiagnostics) {}

  async openAsHost(): Promise<Result<void>> {
    return this.begin();
  }

  async openAsGuest(): Promise<Result<void>> {
    return this.begin();
  }

  private begin(): Result<void> {
    this.state = 'connecting';
    // Fail on the next tick, the way a real ICE failure would.
    queueMicrotask(() => {
      this.state = 'failed';
      for (const listener of this.listeners) listener('failed');
    });
    return ok(undefined);
  }

  send(_channel: Channel, _data: ArrayBuffer | string): void {
    /* never opens */
  }

  onData(_listener: Listener<PeerPayload>): Unsubscribe {
    return () => undefined;
  }

  onStateChange(listener: Listener<LinkState>): Unsubscribe {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  close(): void {
    this.state = 'closed';
  }

  // The call is irrelevant to a link that never opens.
  attachLocalMedia(): void {
    /* nothing to send */
  }

  onRemoteMedia(): Unsubscribe {
    return () => undefined;
  }

  setMicrophoneMuted(): void {
    /* nothing to mute */
  }

  setCameraMuted(): void {
    /* nothing to mute */
  }
}

const diagnostics = (overrides: Partial<LinkDiagnostics> = {}): LinkDiagnostics => ({
  localCandidateTypes: ['host', 'srflx'],
  remoteCandidates: 6,
  turnConfigured: false,
  gotRemoteDescription: true,
  iceConnectionState: 'failed',
  ...overrides,
});

async function messageFor(diag: LinkDiagnostics): Promise<string> {
  const logger = new SilentLogger();
  const clock = new FakeClock();
  // The room has to be there. A guest now watches it for the host's start, so
  // an empty repository reports "the room disappeared" and that failure — a
  // true one — arrives before the link's, hiding the diagnosis under test.
  const matches = new FakeMatchRepository();
  matches.rooms.set(MATCH.code, MATCH);
  const lobby = new LobbyService(matches, new FakeCatalog(), clock, new FakeShare(), logger);
  const pairing = new PairingService(() => new FailingLink(diag), lobby, logger);

  // Joining reports through stages rather than resolving, because a guest now
  // sits in the room until the host starts. The failure is still the only
  // terminal stage, so this waits for it.
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('expected the connection to fail'));
    }, 2000);
    pairing.joinRoom({
      session: SESSION,
      match: MATCH,
      onStage: (stage) => {
        if (stage.kind !== 'failed') return;
        clearTimeout(timer);
        resolve(stage.message);
      },
    });
  });
}

describe('explaining a failed connection', () => {
  it('says the other player never answered when nothing came back', async () => {
    const message = await messageFor(
      diagnostics({ gotRemoteDescription: false, remoteCandidates: 0 }),
    );
    expect(message).toMatch(/closed the connection|never answered/i);
  });

  it('blames the network when STUN could not be reached', async () => {
    // Only local-network candidates: the browser never discovered its own
    // public address, so something is blocking STUN.
    const message = await messageFor(diagnostics({ localCandidateTypes: ['host'] }));
    expect(message).toContain('STUN');
  });

  it('asks for a relay when both sides were reachable but no path agreed', async () => {
    // The classic symmetric-NAT case, and the likeliest one on mobile data.
    const message = await messageFor(diagnostics({ turnConfigured: false }));
    expect(message).toMatch(/TURN relay/i);
    expect(message).toMatch(/mobile data/i);
  });

  it('does not blame the relay setup when a relay was already configured', async () => {
    const message = await messageFor(
      diagnostics({ turnConfigured: true, localCandidateTypes: ['host', 'srflx', 'relay'] }),
    );
    expect(message).not.toMatch(/see README/i);
    expect(message).toMatch(/relay/i);
  });

  it('never falls back to the message that says nothing', async () => {
    for (const diag of [
      diagnostics(),
      diagnostics({ localCandidateTypes: [] }),
      diagnostics({ turnConfigured: true }),
      diagnostics({ gotRemoteDescription: false, remoteCandidates: 0 }),
    ]) {
      expect(await messageFor(diag)).not.toBe('The connection dropped during setup.');
    }
  });
});
