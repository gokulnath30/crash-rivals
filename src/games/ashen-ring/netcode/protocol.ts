import { IDLE_INTENT, RING, type Intent, type Stance } from '@domain/arena/brawler.ts';
import type { ArenaEvent, AttackName, BrawlerIndex } from '@domain/arena/events.ts';
import { PHASES, STANCES, type BrawlerState, type FightState } from '@domain/arena/snapshot.ts';

/**
 * What crosses the connection, and how.
 *
 * Two shapes, for two very different jobs. The things sent *every frame* —
 * the guest's intent and the host's snapshot — are hand-packed binary on the
 * unreliable channel: three bytes and fifty-seven bytes respectively, where the
 * same data as JSON would be several times the size and arrive later. The
 * things sent *rarely* but which must not be lost — hits, round changes, who
 * you are — are JSON on the reliable channel, where clarity is worth more
 * than bytes.
 *
 * **Nothing off the wire is trusted.** Every decoder validates and returns
 * null rather than throwing, and every number is clamped to what the rules
 * could actually have produced. The far end is somebody else's browser.
 */

/**
 * First byte of a binary packet, so one channel can carry both directions and
 * each side can ignore the one it has no use for.
 */
const KIND_INTENT = 1;
const KIND_STATE = 2;

export const INTENT_BYTES = 3;
/** Nine bytes of scoreboard, then twenty-four for each fighter. */
export const STATE_BYTES = 57;
const BRAWLER_BYTES = 24;

// ------------------------------------------------------------------ intent

/** Bit positions in the intent's button byte. */
const BUTTONS = ['run', 'guard', 'jump', 'punch', 'kick', 'sweep', 'uppercut'] as const;

/** The guest's controls, in three bytes. */
export function encodeIntent(intent: Intent): ArrayBuffer {
  const buffer = new ArrayBuffer(INTENT_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, KIND_INTENT);
  // Shifted into 0..2, because a byte has no sign and the move does.
  view.setUint8(1, intent.move + 1);
  let bits = 0;
  for (const [index, name] of BUTTONS.entries()) {
    if (intent[name]) bits |= 1 << index;
  }
  view.setUint8(2, bits);
  return buffer;
}

export function decodeIntent(data: unknown): Intent | null {
  const view = viewOf(data, INTENT_BYTES);
  if (!view || view.getUint8(0) !== KIND_INTENT) return null;

  const move = view.getUint8(1) - 1;
  if (move !== -1 && move !== 0 && move !== 1) return null;
  const bits = view.getUint8(2);
  const pressed = (index: number): boolean => (bits & (1 << index)) !== 0;

  return {
    ...IDLE_INTENT,
    move,
    run: pressed(0),
    guard: pressed(1),
    jump: pressed(2),
    punch: pressed(3),
    kick: pressed(4),
    sweep: pressed(5),
    uppercut: pressed(6),
  };
}

// ------------------------------------------------------------------- state

/** The whole fight as the host sees it, in fifty-seven bytes. */
export function encodeState(state: FightState): ArrayBuffer {
  const buffer = new ArrayBuffer(STATE_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, KIND_STATE);
  view.setUint8(1, clampByte(state.round));
  view.setUint8(2, Math.max(0, PHASES.indexOf(state.phase)));
  view.setUint8(3, clampByte(state.wins[0]));
  view.setUint8(4, clampByte(state.wins[1]));
  view.setFloat32(5, state.timeLeft, true);
  writeBrawler(view, 9, state.brawlers[0]);
  writeBrawler(view, 9 + BRAWLER_BYTES, state.brawlers[1]);
  return buffer;
}

export function decodeState(data: unknown): FightState | null {
  const view = viewOf(data, STATE_BYTES);
  if (!view || view.getUint8(0) !== KIND_STATE) return null;

  const phase = PHASES[view.getUint8(2)];
  if (!phase) return null;
  const first = readBrawler(view, 9);
  const second = readBrawler(view, 9 + BRAWLER_BYTES);
  if (!first || !second) return null;

  const timeLeft = view.getFloat32(5, true);
  return {
    round: view.getUint8(1),
    phase,
    timeLeft: Number.isFinite(timeLeft) ? clamp(timeLeft, 0, RING.roundSeconds) : 0,
    wins: [view.getUint8(3), view.getUint8(4)],
    brawlers: [first, second],
  };
}

function writeBrawler(view: DataView, at: number, state: BrawlerState): void {
  view.setFloat32(at, state.x, true);
  view.setFloat32(at + 4, state.y, true);
  view.setFloat32(at + 8, state.stanceTime, true);
  view.setFloat32(at + 12, state.velocity, true);
  view.setFloat32(at + 16, state.verticalVelocity, true);
  view.setInt8(at + 20, state.facing);
  view.setUint8(at + 21, Math.max(0, STANCES.indexOf(state.stance)));
  view.setUint8(at + 22, clampByte(state.hp));
  view.setInt8(at + 23, state.stride);
}

function readBrawler(view: DataView, at: number): BrawlerState | null {
  const stance = STANCES[view.getUint8(at + 21)];
  if (!stance) return null;

  const x = view.getFloat32(at, true);
  const y = view.getFloat32(at + 4, true);
  const stanceTime = view.getFloat32(at + 8, true);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(stanceTime)) return null;

  const facing = view.getInt8(at + 20) < 0 ? -1 : 1;
  const stride = Math.sign(view.getInt8(at + 23)) as -1 | 0 | 1;
  return {
    // Clamped to the ring: a peer claiming a fighter a mile away gets one
    // standing at the wall instead.
    x: clamp(x, -RING.halfWidth, RING.halfWidth),
    y: clamp(y, 0, 4),
    facing,
    stance,
    stanceTime: clamp(stanceTime, 0, 30),
    stride,
    hp: clamp(view.getUint8(at + 22), 0, RING.maxHp),
    // Fast enough for the running speed and a hard shove, and no faster.
    velocity: clamp(finite(view.getFloat32(at + 12, true)), -12, 12),
    verticalVelocity: clamp(finite(view.getFloat32(at + 16, true)), -20, 20),
  };
}

const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

// ------------------------------------------------------------------ events

/** The rare messages, where being certain matters more than being small. */
export type NetMessage =
  | { readonly t: 'hello'; readonly name: string; readonly pick: string }
  | { readonly t: 'fx'; readonly events: readonly ArenaEvent[] }
  /** The guest asking the host to start, or to move to the next round. */
  | { readonly t: 'ready' }
  | { readonly t: 'bye' };

export const encodeMessage = (message: NetMessage): string => JSON.stringify(message);

/** Reads one, keeping only what is well formed. Never throws. */
export function decodeMessage(data: unknown): NetMessage | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const message = parsed as { t?: unknown; name?: unknown; pick?: unknown; events?: unknown };

  switch (message.t) {
    case 'hello':
      if (typeof message.name !== 'string' || typeof message.pick !== 'string') return null;
      // A name is going on a health bar, so it is length-limited here rather
      // than trusted to be reasonable.
      return { t: 'hello', name: message.name.slice(0, 24), pick: message.pick.slice(0, 32) };
    case 'ready':
      return { t: 'ready' };
    case 'bye':
      return { t: 'bye' };
    case 'fx': {
      if (!Array.isArray(message.events)) return null;
      const events = message.events
        .map((event) => cleanEvent(event))
        .filter((event): event is ArenaEvent => event !== null)
        .slice(0, MAX_EVENTS);
      return { t: 'fx', events };
    }
    default:
      return null;
  }
}

/** More than this in one message is a peer being silly, not a busy exchange. */
const MAX_EVENTS = 24;

const ATTACK_NAMES: readonly AttackName[] = ['punch', 'kick', 'sweep', 'uppercut', 'air-kick'];

/**
 * Validates one event off the wire, returning null for anything that is not
 * exactly the shape the rules produce.
 */
function cleanEvent(value: unknown): ArenaEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const event = value as Record<string, unknown>;
  const index = (v: unknown): BrawlerIndex | null => (v === 0 || v === 1 ? v : null);
  const move = (v: unknown): AttackName | null =>
    typeof v === 'string' && ATTACK_NAMES.includes(v as AttackName) ? (v as AttackName) : null;

  switch (event['kind']) {
    case 'attack': {
      const attacker = index(event['attacker']);
      const name = move(event['move']);
      return attacker !== null && name ? { kind: 'attack', attacker, move: name } : null;
    }
    case 'whiff': {
      const attacker = index(event['attacker']);
      const name = move(event['move']);
      return attacker !== null && name ? { kind: 'whiff', attacker, move: name } : null;
    }
    case 'hit': {
      const attacker = index(event['attacker']);
      const defender = index(event['defender']);
      const name = move(event['move']);
      if (attacker === null || defender === null || !name) return null;
      return {
        kind: 'hit',
        attacker,
        defender,
        move: name,
        // A peer claiming a 9000-damage jab gets it clamped.
        damage: clamp(number(event['damage']), 0, RING.maxHp),
        blocked: event['blocked'] === true,
        knockdown: event['knockdown'] === true,
        x: clamp(number(event['x']), -RING.halfWidth, RING.halfWidth),
        y: clamp(number(event['y']), 0, 4),
      };
    }
    case 'round-start': {
      const round = clamp(number(event['round']), 1, 255);
      return { kind: 'round-start', round };
    }
    case 'fight-call':
      return { kind: 'fight-call' };
    case 'round-end': {
      const winner = event['winner'] === null ? null : index(event['winner']);
      if (winner === undefined) return null;
      const wins = event['wins'];
      if (!Array.isArray(wins) || wins.length !== 2) return null;
      return {
        kind: 'round-end',
        winner,
        round: clamp(number(event['round']), 1, 255),
        wins: [clamp(number(wins[0]), 0, 9), clamp(number(wins[1]), 0, 9)],
        matchOver: event['matchOver'] === true,
      };
    }
    case 'announce': {
      const text = event['text'];
      if (typeof text !== 'string') return null;
      return {
        kind: 'announce',
        text: text.slice(0, 24),
        holdMs: clamp(number(event['holdMs']), 100, 5000),
      };
    }
    default:
      return null;
  }
}

// ----------------------------------------------------------------- helpers

function viewOf(data: unknown, bytes: number): DataView | null {
  if (!(data instanceof ArrayBuffer) || data.byteLength !== bytes) return null;
  return new DataView(data);
}

const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const clamp = (value: number, lo: number, hi: number): number =>
  value < lo ? lo : value > hi ? hi : value;

const clampByte = (value: number): number => Math.round(clamp(value, 0, 255));

/** Which stance an index means. Exported so tests can pin the wire order. */
export const stanceAt = (index: number): Stance | undefined => STANCES[index];
