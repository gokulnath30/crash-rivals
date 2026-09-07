import type { ActionName } from './actions.ts';
import type { Dataset, Sample } from './dataset.ts';
import { distance } from './features.ts';

/**
 * The model: k nearest neighbours over the recorded examples.
 *
 * Chosen on purpose over anything with weights to fit. A person recording in
 * this room will give it eight or ten examples of each action, and with that
 * much data a nearest-neighbour vote is both the most accurate thing
 * available and the only one that can explain itself — a match is a
 * particular take you performed, not a number nobody can point at. It also
 * trains instantly, so recording a sample improves recognition on the very
 * next frame rather than after a wait.
 *
 * The exported dataset is the thing to feed a larger model later; this one is
 * what makes the room useful today.
 */
export interface Verdict {
  readonly action: ActionName;
  /** 0..1. The share of the vote, damped by how far the nearest example was. */
  readonly confidence: number;
  /** Distance to the closest example, for a meter that shows the fit. */
  readonly distance: number;
}

/** How many neighbours vote. */
export const NEIGHBOURS = 3;

/**
 * Beyond this distance a window is unlike anything recorded, and the honest
 * answer is silence rather than the least bad label. In torso-lengths, so it
 * means the same thing for every body.
 */
export const MAX_DISTANCE = 9;

export class GestureClassifier {
  private readonly samples: readonly Sample[];

  constructor(dataset: Dataset) {
    this.samples = dataset.samples;
  }

  /** True once there is something to compare against. */
  get trained(): boolean {
    return this.samples.length > 0;
  }

  /**
   * The action a window of movement most resembles, or null when it
   * resembles nothing recorded.
   */
  classify(features: ArrayLike<number>): Verdict | null {
    if (this.samples.length === 0) return null;

    const scored = this.samples
      .map((sample) => ({ action: sample.action, gap: distance(features, sample.features) }))
      .sort((a, b) => a.gap - b.gap);

    const nearest = scored[0];
    if (!nearest || nearest.gap > MAX_DISTANCE) return null;

    const voters = scored.slice(0, Math.min(NEIGHBOURS, scored.length));
    // Weighted by closeness, so a neighbour that is barely similar does not
    // carry the same say as one that matches almost exactly.
    const weights = new Map<ActionName, number>();
    let total = 0;
    for (const voter of voters) {
      const weight = 1 / (voter.gap + 0.1);
      weights.set(voter.action, (weights.get(voter.action) ?? 0) + weight);
      total += weight;
    }

    let best: ActionName = nearest.action;
    let bestWeight = 0;
    for (const [action, weight] of weights) {
      if (weight > bestWeight) {
        best = action;
        bestWeight = weight;
      }
    }

    const share = total > 0 ? bestWeight / total : 0;
    // A perfect match scores 1 and fades to 0 at the edge of what counts as
    // recognisable at all.
    const closeness = Math.max(0, 1 - nearest.gap / MAX_DISTANCE);
    return { action: best, confidence: share * closeness, distance: nearest.gap };
  }
}

/**
 * Turns a stream of verdicts into decisions.
 *
 * Two things stop a classifier from being unusable as a controller. A verdict
 * has to clear a confidence bar before it counts at all, and an action that
 * has just fired cannot fire again immediately — otherwise one punch, held
 * across twenty frames of a window, is twenty punches.
 */
export class ActionGate {
  private lastFired: ActionName | null = null;
  private sinceFired = 0;

  constructor(
    private readonly minConfidence = 0.55,
    /** Seconds before the same action may fire again. */
    private readonly repeatDelay = 0.55,
  ) {}

  /**
   * @returns the action to act on this frame, or null.
   */
  accept(verdict: Verdict | null, dt: number): ActionName | null {
    this.sinceFired += dt;
    if (!verdict || verdict.confidence < this.minConfidence) return null;

    // Idle is a state, not a thing that happens; noticing it only clears the
    // way for the next real action.
    if (verdict.action === 'idle') {
      this.lastFired = null;
      return 'idle';
    }

    if (verdict.action === this.lastFired && this.sinceFired < this.repeatDelay) return null;

    this.lastFired = verdict.action;
    this.sinceFired = 0;
    return verdict.action;
  }

  reset(): void {
    this.lastFired = null;
    this.sinceFired = 0;
  }
}
