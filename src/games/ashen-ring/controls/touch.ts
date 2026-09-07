import { IDLE_INTENT, type Intent } from '@domain/arena/brawler.ts';
import { el, on } from '@ui/dom.ts';
import type { InputSource } from './input.ts';

/** How far the thumb moves before it counts, as a fraction of the stick radius. */
const STICK_DEADZONE = 0.3;
/** Pushed this far sideways, the fighter runs. */
const STICK_RUN = 0.85;
/** Pushed this far up (or down) it is a jump (or a guard). */
const STICK_VERTICAL = 0.55;
/** The stick's travel radius in CSS pixels. */
const STICK_RADIUS = 56;

type Action = 'punch' | 'kick' | 'sweep' | 'uppercut' | 'guard';

/** What fits under a letter on a thumb-sized button. */
const SHORT_NAMES: Readonly<Record<Action, string>> = {
  punch: 'punch',
  kick: 'kick',
  sweep: 'sweep',
  uppercut: 'upper',
  guard: 'guard',
};

/**
 * Thumb controls for phones and tablets: a stick that appears under the left
 * thumb wherever it lands, and a diamond of limb buttons under the right one,
 * with guard beside it. The same layout every touch fighting game has settled
 * on, so a player's hands already know it.
 *
 * Pointer events rather than touch events, so every finger is tracked on its
 * own and a kick does not lift the stick.
 */
export class TouchPad implements InputSource {
  readonly root: HTMLElement;

  private readonly stickZone: HTMLElement;
  private readonly stickBase: HTMLElement;
  private readonly stickKnob: HTMLElement;
  private stickPointer: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  /** -1..1 on each axis, y positive downward as on screen. */
  private stick = { x: 0, y: 0 };
  private jumpArmed = true;

  private readonly held = new Map<Action, Set<number>>();
  private readonly queued = new Set<Action>();
  private jumpQueued = false;
  private readonly detach: (() => void)[] = [];

  constructor(mount: HTMLElement) {
    this.stickBase = el('div', { className: 'ar__stick' }, [
      (this.stickKnob = el('div', { className: 'ar__stick-knob' })),
    ]);
    this.stickBase.hidden = true;
    this.stickZone = el('div', { className: 'ar__stick-zone', attrs: { 'aria-label': 'Move' } }, [
      this.stickBase,
      el('div', { className: 'ar__stick-hint', text: 'move · up jumps · down guards' }),
    ]);

    const button = (action: Action, label: string, className: string): HTMLElement => {
      const node = el('button', {
        className: `ar__tbtn ${className}`,
        attrs: { type: 'button', 'aria-label': action },
      }, [el('b', { text: label }), el('span', { text: SHORT_NAMES[action] })]);
      this.held.set(action, new Set());
      this.detach.push(
        on(node, 'pointerdown', (event) => {
          event.preventDefault();
          node.setPointerCapture(event.pointerId);
          this.held.get(action)?.add(event.pointerId);
          if (action !== 'guard') this.queued.add(action);
          node.classList.add('is-down');
        }),
        on(node, 'pointerup', (event) => {
          this.release(action, event.pointerId, node);
        }),
        on(node, 'pointercancel', (event) => {
          this.release(action, event.pointerId, node);
        }),
      );
      return node;
    };

    const buttons = el('div', { className: 'ar__buttons' }, [
      button('guard', 'G', 'ar__tbtn--guard'),
      el('div', { className: 'ar__diamond' }, [
        button('punch', 'P', 'ar__tbtn--punch'),
        button('uppercut', 'U', 'ar__tbtn--uppercut'),
        button('kick', 'K', 'ar__tbtn--kick'),
        button('sweep', 'S', 'ar__tbtn--sweep'),
      ]),
    ]);

    this.root = el('div', { className: 'ar__touch' }, [this.stickZone, buttons]);
    mount.append(this.root);

    this.detach.push(
      on(this.stickZone, 'pointerdown', (event) => {
        if (this.stickPointer !== null) return;
        event.preventDefault();
        this.stickZone.setPointerCapture(event.pointerId);
        this.stickPointer = event.pointerId;
        this.stickOrigin = { x: event.clientX, y: event.clientY };
        this.stick = { x: 0, y: 0 };
        this.jumpArmed = true;
        const zone = this.stickZone.getBoundingClientRect();
        this.stickBase.style.left = `${event.clientX - zone.left}px`;
        this.stickBase.style.top = `${event.clientY - zone.top}px`;
        this.stickBase.hidden = false;
        this.placeKnob();
      }),
      on(this.stickZone, 'pointermove', (event) => {
        if (event.pointerId !== this.stickPointer) return;
        const dx = (event.clientX - this.stickOrigin.x) / STICK_RADIUS;
        const dy = (event.clientY - this.stickOrigin.y) / STICK_RADIUS;
        const length = Math.hypot(dx, dy);
        const scale = length > 1 ? 1 / length : 1;
        this.stick = { x: dx * scale, y: dy * scale };
        // Up is an edge: one jump per push, re-armed once the thumb comes back.
        if (this.stick.y < -STICK_VERTICAL && this.jumpArmed) {
          this.jumpQueued = true;
          this.jumpArmed = false;
        } else if (this.stick.y > -STICK_VERTICAL * 0.5) {
          this.jumpArmed = true;
        }
        this.placeKnob();
      }),
      on(this.stickZone, 'pointerup', (event) => {
        this.liftStick(event.pointerId);
      }),
      on(this.stickZone, 'pointercancel', (event) => {
        this.liftStick(event.pointerId);
      }),
    );
  }

  read(): Intent {
    const x = Math.abs(this.stick.x) > STICK_DEADZONE ? this.stick.x : 0;
    const intent: Intent = {
      ...IDLE_INTENT,
      move: x === 0 ? 0 : x < 0 ? -1 : 1,
      run: Math.abs(this.stick.x) > STICK_RUN,
      guard: (this.held.get('guard')?.size ?? 0) > 0 || this.stick.y > STICK_VERTICAL,
      jump: this.jumpQueued,
      punch: this.queued.has('punch'),
      kick: this.queued.has('kick'),
      sweep: this.queued.has('sweep'),
      uppercut: this.queued.has('uppercut'),
    };
    this.queued.clear();
    this.jumpQueued = false;
    return intent;
  }

  dispose(): void {
    for (const remove of this.detach.splice(0)) remove();
    this.root.remove();
  }

  private release(action: Action, pointerId: number, node: HTMLElement): void {
    const set = this.held.get(action);
    set?.delete(pointerId);
    if ((set?.size ?? 0) === 0) node.classList.remove('is-down');
  }

  private liftStick(pointerId: number): void {
    if (pointerId !== this.stickPointer) return;
    this.stickPointer = null;
    this.stick = { x: 0, y: 0 };
    this.stickBase.hidden = true;
  }

  private placeKnob(): void {
    this.stickKnob.style.transform = `translate(${this.stick.x * STICK_RADIUS}px, ${this.stick.y * STICK_RADIUS}px)`;
  }
}
