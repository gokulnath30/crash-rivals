import { describe, expect, it } from 'vitest';
import { ATTACKS, IDLE_INTENT, RING, type Intent } from '@domain/arena/brawler.ts';
import { Fight } from '@domain/arena/fight.ts';
import { INTRO_SECONDS } from '@domain/arena/round.ts';
import {
  applyFightState,
  captureFight,
  PHASES,
  STANCES,
  type FightState,
} from '@domain/arena/snapshot.ts';
import {
  decodeIntent,
  decodeMessage,
  decodeState,
  encodeIntent,
  encodeMessage,
  encodeState,
  INTENT_BYTES,
  STATE_BYTES,
} from '@games/ashen-ring/netcode/protocol.ts';

/**
 * What crosses the wire in an online match.
 *
 * Two browsers have to agree exactly, so the byte layout is pinned here, and
 * every decoder is fed rubbish to prove it says no rather than throwing. The
 * far end is somebody else's browser.
 */
const press = (partial: Partial<Intent>): Intent => ({ ...IDLE_INTENT, ...partial });

/** A fight a few seconds in, so the snapshot has something to say. */
function liveFight(): Fight {
  const fight = new Fight(['HOST', 'GUEST']);
  fight.start();
  for (let t = 0; t < INTRO_SECONDS + 0.5; t += 1 / 120) {
    fight.step([press({ move: 1 }), press({ guard: true })], 1 / 120);
  }
  return fight;
}

describe('the wire order', () => {
  it('never reorders a stance, because the index is the wire format', () => {
    // Appending is fine; changing these breaks every older client.
    expect(STANCES).toEqual([
      'idle',
      'walk',
      'run',
      'guard',
      'jump',
      'punch',
      'kick',
      'sweep',
      'uppercut',
      'hit',
      'knockdown',
    ]);
  });

  it('never reorders a round phase, for the same reason', () => {
    expect(PHASES).toEqual([
      'waiting',
      'intro',
      'fighting',
      'settling',
      'round-over',
      'match-over',
    ]);
  });
});

describe('an intent on the wire', () => {
  it('fits in three bytes and comes back unchanged', () => {
    const intent = press({ move: -1, run: true, punch: true, uppercut: true });
    const packed = encodeIntent(intent);
    expect(packed.byteLength).toBe(INTENT_BYTES);
    expect(decodeIntent(packed)).toEqual(intent);
  });

  it('carries every button independently', () => {
    for (const key of ['run', 'guard', 'jump', 'punch', 'kick', 'sweep', 'uppercut'] as const) {
      const intent = press({ [key]: true });
      expect(decodeIntent(encodeIntent(intent))).toEqual(intent);
    }
  });

  it('carries all three directions', () => {
    for (const move of [-1, 0, 1] as const) {
      expect(decodeIntent(encodeIntent(press({ move })))?.move).toBe(move);
    }
  });

  it('refuses anything that is not an intent', () => {
    expect(decodeIntent(new ArrayBuffer(INTENT_BYTES))).toBeNull(); // wrong kind byte
    expect(decodeIntent(new ArrayBuffer(2))).toBeNull();
    expect(decodeIntent('a string')).toBeNull();
    expect(decodeIntent(null)).toBeNull();
    expect(decodeIntent(encodeState(captureFight(liveFight())))).toBeNull();
  });

  it('refuses a direction that is not one of the three', () => {
    const packed = encodeIntent(IDLE_INTENT);
    new DataView(packed).setUint8(1, 250);
    expect(decodeIntent(packed)).toBeNull();
  });
});

describe('a snapshot on the wire', () => {
  it('fits in the fixed packet and survives the trip', () => {
    const state = captureFight(liveFight());
    const packed = encodeState(state);
    expect(packed.byteLength).toBe(STATE_BYTES);

    const back = decodeState(packed);
    expect(back).not.toBeNull();
    expect(back?.round).toBe(state.round);
    expect(back?.phase).toBe(state.phase);
    expect(back?.wins).toEqual(state.wins);
    expect(back?.timeLeft).toBeCloseTo(state.timeLeft, 3);
    for (const index of [0, 1] as const) {
      const from = state.brawlers[index];
      const to = back?.brawlers[index];
      expect(to?.stance).toBe(from.stance);
      expect(to?.facing).toBe(from.facing);
      expect(to?.hp).toBe(from.hp);
      expect(to?.stride).toBe(from.stride);
      expect(to?.x).toBeCloseTo(from.x, 3);
      expect(to?.y).toBeCloseTo(from.y, 3);
      expect(to?.stanceTime).toBeCloseTo(from.stanceTime, 3);
      expect(to?.velocity).toBeCloseTo(from.velocity, 3);
    }
  });

  it('carries every stance a fighter can be in', () => {
    const state = captureFight(liveFight());
    for (const stance of STANCES) {
      const posed: FightState = {
        ...state,
        brawlers: [{ ...state.brawlers[0], stance }, state.brawlers[1]],
      };
      expect(decodeState(encodeState(posed))?.brawlers[0].stance).toBe(stance);
    }
  });

  it('clamps a fighter a peer claims is a mile outside the ring', () => {
    const state = captureFight(liveFight());
    const absurd: FightState = {
      ...state,
      brawlers: [
        { ...state.brawlers[0], x: 5000, y: 900, velocity: 1e9, hp: 250 },
        state.brawlers[1],
      ],
    };
    const back = decodeState(encodeState(absurd));
    expect(back?.brawlers[0].x).toBe(RING.halfWidth);
    expect(back?.brawlers[0].y).toBeLessThanOrEqual(4);
    expect(back?.brawlers[0].velocity).toBeLessThanOrEqual(12);
    expect(back?.brawlers[0].hp).toBeLessThanOrEqual(RING.maxHp);
  });

  it('says no to a packet with a stance nobody has', () => {
    const packed = encodeState(captureFight(liveFight()));
    new DataView(packed).setUint8(9 + 21, 200);
    expect(decodeState(packed)).toBeNull();
  });

  it('says no to a packet with a phase nobody is in', () => {
    const packed = encodeState(captureFight(liveFight()));
    new DataView(packed).setUint8(2, 99);
    expect(decodeState(packed)).toBeNull();
  });

  it('refuses anything that is not a snapshot', () => {
    expect(decodeState(new ArrayBuffer(STATE_BYTES))).toBeNull();
    expect(decodeState(new ArrayBuffer(10))).toBeNull();
    expect(decodeState('{}')).toBeNull();
    expect(decodeState(encodeIntent(IDLE_INTENT))).toBeNull();
  });
});

describe('adopting the host account of the fight', () => {
  it('puts the guest exactly where the host says everyone is', () => {
    const host = liveFight();
    const guest = new Fight(['HOST', 'GUEST']);
    const state = decodeState(encodeState(captureFight(host)));
    expect(state).not.toBeNull();
    applyFightState(guest, state as FightState);

    expect(guest.round.phase).toBe(host.round.phase);
    expect(guest.round.timeLeft).toBeCloseTo(host.round.timeLeft, 3);
    for (const index of [0, 1] as const) {
      expect(guest.brawlers[index].x).toBeCloseTo(host.brawlers[index].x, 3);
      expect(guest.brawlers[index].stance).toBe(host.brawlers[index].stance);
      expect(guest.brawlers[index].hp).toBe(host.brawlers[index].hp);
    }
  });

  it('rebuilds the attack from the stance, already spent', () => {
    const fight = new Fight(['A', 'B']);
    fight.brawlers[0].adopt({
      x: 0,
      y: 0,
      facing: 1,
      stance: 'kick',
      stanceTime: 0.3,
      stride: 0,
      hp: 80,
      velocity: 0,
      verticalVelocity: 0,
    });
    // The animator needs a spec to time the swing against...
    expect(fight.brawlers[0].attack?.spec).toBe(ATTACKS.kick);
    // ...but a replayed pose must never decide a hit on the guest's screen.
    expect(fight.brawlers[0].attackIsLive).toBe(false);
  });
});

describe('the messages that must not be lost', () => {
  it('carries a greeting, and trims a name that would not fit a health bar', () => {
    const long = 'x'.repeat(200);
    const back = decodeMessage(encodeMessage({ t: 'hello', name: long, pick: 'sable' }));
    expect(back?.t).toBe('hello');
    expect(back?.t === 'hello' && back.name.length).toBeLessThanOrEqual(24);
    expect(back?.t === 'hello' && back.pick).toBe('sable');
  });

  it('carries ready and bye', () => {
    expect(decodeMessage(encodeMessage({ t: 'ready' }))?.t).toBe('ready');
    expect(decodeMessage(encodeMessage({ t: 'bye' }))?.t).toBe('bye');
  });

  it('carries the events that make the spectacle', () => {
    const back = decodeMessage(
      encodeMessage({
        t: 'fx',
        events: [
          { kind: 'round-start', round: 2 },
          { kind: 'fight-call' },
          { kind: 'attack', attacker: 0, move: 'kick' },
          {
            kind: 'hit',
            attacker: 0,
            defender: 1,
            move: 'kick',
            damage: 14,
            blocked: false,
            knockdown: false,
            x: 1.2,
            y: 1.15,
          },
          { kind: 'announce', text: 'K.O.', holdMs: 1400 },
          { kind: 'round-end', winner: 0, round: 2, wins: [2, 0], matchOver: true },
        ],
      }),
    );
    expect(back?.t).toBe('fx');
    expect(back?.t === 'fx' && back.events).toHaveLength(6);
  });

  it('clamps a peer claiming a nine-thousand-damage jab', () => {
    const back = decodeMessage(
      encodeMessage({
        t: 'fx',
        events: [
          {
            kind: 'hit',
            attacker: 0,
            defender: 1,
            move: 'punch',
            damage: 9000,
            blocked: false,
            knockdown: true,
            x: 0,
            y: 1.4,
          },
        ],
      }),
    );
    const hit = back?.t === 'fx' ? back.events[0] : null;
    expect(hit?.kind === 'hit' && hit.damage).toBe(RING.maxHp);
  });

  it('drops malformed events and keeps the good ones', () => {
    const text = JSON.stringify({
      t: 'fx',
      events: [
        { kind: 'fight-call' },
        { kind: 'hit', attacker: 7, defender: 1, move: 'punch' },
        { kind: 'attack', attacker: 0, move: 'headbutt' },
        { kind: 'not-a-thing' },
        'nonsense',
        null,
      ],
    });
    const back = decodeMessage(text);
    expect(back?.t === 'fx' && back.events).toHaveLength(1);
  });

  it('says no to anything that is not one of ours', () => {
    expect(decodeMessage('not json')).toBeNull();
    expect(decodeMessage('null')).toBeNull();
    expect(decodeMessage('[]')).toBeNull();
    expect(decodeMessage(JSON.stringify({ t: 'drop-tables' }))).toBeNull();
    expect(decodeMessage(JSON.stringify({ t: 'hello' }))).toBeNull();
    expect(decodeMessage(JSON.stringify({ t: 'fx', events: 'lots' }))).toBeNull();
    expect(decodeMessage(new ArrayBuffer(4))).toBeNull();
  });
});
