import { IDLE_INTENT, type Intent } from '@domain/arena/brawler.ts';

/**
 * Anything that can drive a fighter: a keyboard, a gamepad, a touch overlay.
 *
 * All of them produce the same `Intent` once a frame, so the fight never
 * knows which one a player is holding, and a player can hold several at once.
 */
export interface InputSource {
  read(): Intent;
  dispose(): void;
}

/**
 * Folds several sources into one intent: any held direction wins (the first
 * source that has one), and every button is the union. Pressing punch on a
 * gamepad while walking with the keyboard is exactly what it sounds like.
 */
export function mergeIntents(intents: readonly Intent[]): Intent {
  let merged: Intent = IDLE_INTENT;
  for (const intent of intents) {
    merged = {
      move: merged.move !== 0 ? merged.move : intent.move,
      run: merged.run || intent.run,
      guard: merged.guard || intent.guard,
      jump: merged.jump || intent.jump,
      punch: merged.punch || intent.punch,
      kick: merged.kick || intent.kick,
      sweep: merged.sweep || intent.sweep,
      uppercut: merged.uppercut || intent.uppercut,
    };
  }
  return merged;
}

/** One player's hands, however many devices they are on. */
export class MergedInput implements InputSource {
  constructor(private readonly sources: readonly InputSource[]) {}

  read(): Intent {
    return mergeIntents(this.sources.map((source) => source.read()));
  }

  dispose(): void {
    for (const source of this.sources) source.dispose();
  }
}

/**
 * Whether this is a device you poke rather than type on.
 *
 * A coarse primary pointer is the honest signal: phones and tablets report
 * it, laptops with a touchscreen do not, and a laptop with a touchscreen
 * still has a keyboard.
 */
export function isTouchDevice(): boolean {
  try {
    if (matchMedia('(pointer: coarse)').matches) return true;
    return navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches;
  } catch {
    return false;
  }
}
