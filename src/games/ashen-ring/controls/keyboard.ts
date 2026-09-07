import type { Intent } from '@domain/arena/brawler.ts';
import { on } from '@ui/dom.ts';
import type { InputSource } from './input.ts';

/**
 * Which keys do what for one fighter. All lower-case `KeyboardEvent.key`
 * values, so a map can mix letters, arrows and punctuation.
 */
export interface KeyMap {
  readonly left: readonly string[];
  readonly right: readonly string[];
  readonly guard: readonly string[];
  readonly jump: readonly string[];
  readonly punch: readonly string[];
  readonly kick: readonly string[];
  readonly sweep: readonly string[];
  readonly uppercut: readonly string[];
  /** Held to run. Optional: a double-tap on a direction runs too. */
  readonly run: readonly string[];
}

export const PLAYER_ONE_KEYS: KeyMap = {
  left: ['a'],
  right: ['d'],
  guard: ['s'],
  jump: ['w'],
  punch: ['j'],
  kick: ['k'],
  sweep: ['l'],
  uppercut: ['u'],
  run: ['shift'],
};

/** The second player's cluster. Offered to a solo player as well. */
export const ARROW_KEYS: KeyMap = {
  left: ['arrowleft'],
  right: ['arrowright'],
  guard: ['arrowdown'],
  jump: ['arrowup'],
  punch: [',', '1'],
  kick: ['.', '2'],
  sweep: ['/', '3'],
  uppercut: ['m', '0'],
  run: [],
};

/** The buttons that are read once per press rather than while held. */
const EDGE_ACTIONS = ['jump', 'punch', 'kick', 'sweep', 'uppercut'] as const;
type EdgeAction = (typeof EDGE_ACTIONS)[number];
const ALL_ACTIONS: readonly (keyof KeyMap)[] = [
  'left',
  'right',
  'guard',
  'run',
  ...EDGE_ACTIONS,
];

/** Two presses of the same direction within this window start a run. */
const DOUBLE_TAP_MS = 260;

/**
 * One fighter's keyboard.
 *
 * Movement and guard are read as held keys; the attack and jump buttons are
 * edges, taken once per press so a held button is one blow and not sixty. A
 * run is either a held modifier or, as in every game of this kind, a
 * double-tap forward.
 */
export class KeyboardPad implements InputSource {
  private readonly held = new Set<string>();
  private readonly queued = new Set<EdgeAction>();
  private lastTap: { key: string; at: number } | null = null;
  /** Set by a double-tap, cleared when that direction is released. */
  private dashing: string | null = null;
  private readonly detach: (() => void)[] = [];
  private readonly maps: readonly KeyMap[];

  constructor(...maps: readonly KeyMap[]) {
    this.maps = maps;
    this.detach.push(
      on(window, 'keydown', (event) => {
        const key = event.key.toLowerCase();
        if (!this.owns(key)) return;
        // Arrows scroll and space jumps the page; neither is what a fight wants.
        event.preventDefault();
        if (event.repeat) return;
        this.held.add(key);
        for (const action of EDGE_ACTIONS) if (this.is(action, key)) this.queued.add(action);
        if (this.is('left', key) || this.is('right', key)) this.noteTap(key, event.timeStamp);
      }),
      on(window, 'keyup', (event) => {
        const key = event.key.toLowerCase();
        this.held.delete(key);
        if (this.dashing === key) this.dashing = null;
      }),
      // A focus change can swallow the keyup, leaving a key stuck down.
      on(window, 'blur', () => {
        this.held.clear();
        this.dashing = null;
      }),
    );
  }

  /** The intent for this frame. Clears the queued presses. */
  read(): Intent {
    const left = this.any('left');
    const right = this.any('right');
    const move: -1 | 0 | 1 = left === right ? 0 : left ? -1 : 1;
    const run = this.any('run') || (this.dashing !== null && this.held.has(this.dashing));
    const intent: Intent = {
      move,
      run,
      guard: this.any('guard'),
      jump: this.queued.has('jump'),
      punch: this.queued.has('punch'),
      kick: this.queued.has('kick'),
      sweep: this.queued.has('sweep'),
      uppercut: this.queued.has('uppercut'),
    };
    this.queued.clear();
    return intent;
  }

  dispose(): void {
    for (const remove of this.detach.splice(0)) remove();
    this.held.clear();
    this.queued.clear();
  }

  private noteTap(key: string, at: number): void {
    const last = this.lastTap;
    if (last && last.key === key && at - last.at < DOUBLE_TAP_MS) {
      this.dashing = key;
      this.lastTap = null;
      return;
    }
    this.lastTap = { key, at };
  }

  private owns(key: string): boolean {
    return this.maps.some((map) => ALL_ACTIONS.some((action) => map[action].includes(key)));
  }

  private is(action: keyof KeyMap, key: string): boolean {
    return this.maps.some((map) => map[action].includes(key));
  }

  private any(action: keyof KeyMap): boolean {
    return this.maps.some((map) => map[action].some((key) => this.held.has(key)));
  }
}

/** A legend for the HUD: pairs of key label and action name. */
export function describeKeys(map: KeyMap): readonly (readonly [string, string])[] {
  const show = (keys: readonly string[]): string =>
    keys
      .slice(0, 1)
      .map((key) => KEY_LABELS[key] ?? key.toUpperCase())
      .join('');
  return [
    [`${show(map.left)} ${show(map.right)}`, 'move'],
    [map.run.length > 0 ? `${show(map.run)} / tap tap` : 'tap tap', 'run'],
    [show(map.jump), 'jump'],
    [show(map.guard), 'guard'],
    [show(map.punch), 'punch'],
    [show(map.kick), 'kick'],
    [show(map.sweep), 'sweep'],
    [show(map.uppercut), 'uppercut'],
  ];
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  arrowleft: '←',
  arrowright: '→',
  arrowdown: '↓',
  arrowup: '↑',
  shift: 'Shift',
  ',': ',',
  '.': '.',
  '/': '/',
};
