import { isActionName, type ActionName } from './actions.ts';
import { FEATURE_DIMENSIONS } from './features.ts';

/**
 * The recordings themselves: what was performed, and the numbers it produced.
 *
 * A sample is deliberately just a label and a feature vector. The raw video
 * never leaves the machine and is never stored — what is kept is the shape of
 * the movement, which is all a classifier can use and all anyone should have
 * to hand over.
 */
export interface Sample {
  readonly action: ActionName;
  /** `FEATURE_DIMENSIONS` numbers, from `windowFeature`. */
  readonly features: readonly number[];
  /** When it was recorded, so a dataset can be pruned oldest-first. */
  readonly atMs: number;
}

export interface Dataset {
  readonly version: 1;
  readonly samples: readonly Sample[];
}

export const EMPTY_DATASET: Dataset = { version: 1, samples: [] };

/** How many decimals a stored feature keeps. Three is well inside the noise. */
const PRECISION = 3;

export function addSample(dataset: Dataset, sample: Sample): Dataset {
  return { version: 1, samples: [...dataset.samples, sample] };
}

/** Drops every example of one action, for re-recording it from scratch. */
export function forgetAction(dataset: Dataset, action: ActionName): Dataset {
  return { version: 1, samples: dataset.samples.filter((sample) => sample.action !== action) };
}

/** Drops the most recent example, for undoing a fumbled take. */
export function forgetLast(dataset: Dataset): Dataset {
  return { version: 1, samples: dataset.samples.slice(0, -1) };
}

/** How many examples there are of each action. */
export function countsByAction(dataset: Dataset): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const sample of dataset.samples) {
    counts[sample.action] = (counts[sample.action] ?? 0) + 1;
  }
  return counts;
}

/** The actions that have at least one example. A classifier needs two. */
export function actionsPresent(dataset: Dataset): readonly ActionName[] {
  return [...new Set(dataset.samples.map((sample) => sample.action))];
}

/**
 * Rounded on the way out, which roughly halves the file and loses nothing a
 * classifier can tell.
 */
export function encodeDataset(dataset: Dataset): string {
  return JSON.stringify({
    version: 1,
    recordedAt: new Date().toISOString(),
    featureDimensions: FEATURE_DIMENSIONS,
    samples: dataset.samples.map((sample) => ({
      action: sample.action,
      atMs: Math.round(sample.atMs),
      features: sample.features.map((value) => Number(value.toFixed(PRECISION))),
    })),
  });
}

/**
 * Reads a dataset back, keeping only what is actually usable.
 *
 * Never throws: a file that came from another version, or from a text editor
 * someone was brave with, produces the samples that survive rather than an
 * error that loses the lot.
 */
export function decodeDataset(text: string): Dataset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return EMPTY_DATASET;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_DATASET;
  const raw = (parsed as { samples?: unknown }).samples;
  if (!Array.isArray(raw)) return EMPTY_DATASET;

  const samples: Sample[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { action, features, atMs } = entry as {
      action?: unknown;
      features?: unknown;
      atMs?: unknown;
    };
    if (typeof action !== 'string' || !isActionName(action)) continue;
    if (!Array.isArray(features) || features.length !== FEATURE_DIMENSIONS) continue;
    if (!features.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) {
      continue;
    }
    samples.push({
      action,
      features,
      atMs: typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : 0,
    });
  }
  return { version: 1, samples };
}
