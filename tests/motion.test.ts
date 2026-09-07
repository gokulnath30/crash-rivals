import { describe, expect, it } from 'vitest';
import { ACTIONS, isActionName } from '@domain/motion/actions.ts';
import { ActionGate, GestureClassifier, MAX_DISTANCE } from '@domain/motion/classifier.ts';
import {
  addSample,
  countsByAction,
  decodeDataset,
  encodeDataset,
  EMPTY_DATASET,
  forgetAction,
  forgetLast,
  type Sample,
} from '@domain/motion/dataset.ts';
import {
  FEATURE_DIMENSIONS,
  normalisePose,
  PoseWindow,
  windowFeature,
} from '@domain/motion/features.ts';
import { isUsable, LANDMARK, type PoseSnapshot, type Triple } from '@domain/motion/landmarks.ts';
import { CAPTURE_SECONDS, COUNTDOWN_SECONDS, TakeRecorder } from '@domain/motion/recorder.ts';

/**
 * The motion domain: how a tracked body becomes numbers, how a take becomes a
 * sample, and how samples become a classifier. All of it runs without a
 * camera, a canvas or a browser.
 */

/** A plausible standing body, in metres, hips at the origin. */
function standing(): Triple[] {
  const points: Triple[] = Array.from({ length: 33 }, () => [0, 0, 0] as Triple);
  points[LANDMARK.nose] = [0, 0.72, 0.08];
  points[LANDMARK.shoulderL] = [0.18, 0.5, 0];
  points[LANDMARK.shoulderR] = [-0.18, 0.5, 0];
  points[LANDMARK.elbowL] = [0.22, 0.25, 0];
  points[LANDMARK.elbowR] = [-0.22, 0.25, 0];
  points[LANDMARK.wristL] = [0.24, 0.02, 0];
  points[LANDMARK.wristR] = [-0.24, 0.02, 0];
  points[LANDMARK.hipL] = [0.1, 0, 0];
  points[LANDMARK.hipR] = [-0.1, 0, 0];
  points[LANDMARK.kneeL] = [0.11, -0.45, 0];
  points[LANDMARK.kneeR] = [-0.11, -0.45, 0];
  points[LANDMARK.ankleL] = [0.11, -0.9, 0];
  points[LANDMARK.ankleR] = [-0.11, -0.9, 0];
  return points;
}

const snapshot = (world: readonly Triple[], atMs: number): PoseSnapshot => ({
  world,
  image: world.map(() => [0.5, 0.5, 0] as Triple),
  visibility: world.map(() => 1),
  atMs,
});

const move = (points: readonly Triple[], by: Triple): Triple[] =>
  points.map((p) => [p[0] + by[0], p[1] + by[1], p[2] + by[2]] as Triple);

const scale = (points: readonly Triple[], by: number): Triple[] =>
  points.map((p) => [p[0] * by, p[1] * by, p[2] * by] as Triple);

const turn = (points: readonly Triple[], radians: number): Triple[] => {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return points.map((p) => [p[0] * cos + p[2] * sin, p[1], -p[0] * sin + p[2] * cos] as Triple);
};

/** The right wrist driven forward, as a punch does. */
function punching(reach: number): Triple[] {
  const points = standing();
  points[LANDMARK.wristR] = [-0.15, 0.45, 0.45 * reach];
  points[LANDMARK.elbowR] = [-0.2, 0.38, 0.2 * reach];
  return points;
}

/** A sequence of frames 40 ms apart, enough to fill a window. */
function sequence(frames: readonly (readonly Triple[])[], startMs = 1000): PoseSnapshot[] {
  return frames.map((world, index) => snapshot(world, startMs + index * 40));
}

/**
 * A window's worth of frames: about 0.7 s at 40 ms apart, the way a camera
 * running at 25 frames a second delivers it.
 */
const WINDOW_FRAMES = 18;

const punchFrames = (): PoseSnapshot[] =>
  sequence(
    Array.from({ length: WINDOW_FRAMES }, (_, index) => {
      // Still, then the hand out and back over the middle of the window.
      const through = (index - 5) / 6;
      if (through <= 0 || through >= 1) return standing();
      return punching(Math.sin(through * Math.PI));
    }),
  );

const idleFrames = (): PoseSnapshot[] =>
  sequence(Array.from({ length: WINDOW_FRAMES }, () => standing()));

describe('reading a pose', () => {
  it('accepts a body whose torso the tracker can see', () => {
    expect(isUsable(snapshot(standing(), 0))).toBe(true);
  });

  it('rejects one whose shoulders are only guesses', () => {
    const frame = snapshot(standing(), 0);
    const blind = { ...frame, visibility: frame.visibility.map((_, i) => (i === LANDMARK.shoulderL ? 0.1 : 1)) };
    expect(isUsable(blind)).toBe(false);
  });

  it('rejects a reading with too few landmarks', () => {
    expect(isUsable(snapshot(standing().slice(0, 12), 0))).toBe(false);
  });
});

describe('normalising a pose', () => {
  const base = normalisePose(standing());

  it('produces one number per axis per key joint', () => {
    expect(base).not.toBeNull();
    expect(base?.length).toBe(FEATURE_DIMENSIONS / 6);
  });

  it('does not care where in the room you stand', () => {
    const moved = normalisePose(move(standing(), [3, -1, 2.5]));
    expect(moved).not.toBeNull();
    for (const [index, value] of (base as Float64Array).entries()) {
      expect(moved?.[index]).toBeCloseTo(value, 6);
    }
  });

  it('does not care how big you are', () => {
    const bigger = normalisePose(scale(standing(), 1.6));
    for (const [index, value] of (base as Float64Array).entries()) {
      expect(bigger?.[index]).toBeCloseTo(value, 6);
    }
  });

  it('does not care which way you have turned', () => {
    const turned = normalisePose(turn(standing(), 0.9));
    for (const [index, value] of (base as Float64Array).entries()) {
      expect(turned?.[index]).toBeCloseTo(value, 6);
    }
  });

  it('does care what your limbs are doing', () => {
    const punch = normalisePose(punching(1));
    expect(punch).not.toBeNull();
    let different = false;
    for (const [index, value] of (base as Float64Array).entries()) {
      if (Math.abs((punch?.[index] ?? 0) - value) > 0.05) different = true;
    }
    expect(different).toBe(true);
  });

  it('refuses a body with no torso to measure', () => {
    const flat = standing().map(() => [0, 0, 0] as Triple);
    expect(normalisePose(flat)).toBeNull();
  });
});

describe('a window of movement', () => {
  it('lays six key frames end to end', () => {
    const feature = windowFeature(punchFrames());
    expect(feature?.length).toBe(FEATURE_DIMENSIONS);
  });

  it('describes a punch differently from standing still', () => {
    const punch = windowFeature(punchFrames()) as Float64Array;
    const idle = windowFeature(idleFrames()) as Float64Array;
    let gap = 0;
    for (const [index, value] of punch.entries()) gap += Math.abs(value - (idle[index] ?? 0));
    expect(gap).toBeGreaterThan(1);
  });

  it('resamples by time, so the same movement at two frame rates agrees', () => {
    const slow = windowFeature(punchFrames()) as Float64Array;
    // The same seven poses, but sampled twice as often.
    const doubled = punchFrames().flatMap((frame, index) => [
      frame,
      snapshot(frame.world, frame.atMs + 20 + index * 0),
    ]);
    const fast = windowFeature(doubled) as Float64Array;
    let worst = 0;
    for (const [index, value] of slow.entries()) {
      worst = Math.max(worst, Math.abs(value - (fast[index] ?? 0)));
    }
    expect(worst).toBeLessThan(0.6);
  });

  it('fills only once it covers enough time', () => {
    const window = new PoseWindow(0.7);
    expect(window.full).toBe(false);
    for (const frame of punchFrames()) window.push(frame);
    expect(window.full).toBe(true);
    expect(window.feature()?.length).toBe(FEATURE_DIMENSIONS);
  });

  it('forgets frames that have fallen out of the window', () => {
    const window = new PoseWindow(0.5);
    for (const frame of sequence(Array.from({ length: 40 }, () => standing()))) window.push(frame);
    // 40 frames at 40 ms is 1.6 s of history; only half a second is kept.
    expect(window.size).toBeLessThanOrEqual(14);
  });
});

describe('recording a take', () => {
  const tick = (recorder: TakeRecorder, seconds: number, frame: PoseSnapshot | null) => {
    let last = recorder.tick(0, frame);
    for (let t = 0; t < seconds; t += 1 / 60) {
      const result = recorder.tick(1 / 60, frame);
      if (result.sample || result.problem) last = result;
    }
    return last;
  };

  it('counts down before it captures anything', () => {
    const recorder = new TakeRecorder();
    recorder.begin('punch', false);
    expect(recorder.state.phase).toBe('counting');
    expect(recorder.state.countdown).toBe(COUNTDOWN_SECONDS);
    recorder.tick(1, snapshot(standing(), 0));
    expect(recorder.state.countdown).toBe(2);
    expect(recorder.state.phase).toBe('counting');
  });

  it('captures, then hands back a labelled sample', () => {
    const recorder = new TakeRecorder();
    recorder.begin('punch', false);
    let produced: Sample | null = null;
    let at = 0;
    for (let i = 0; i < 400; i++) {
      const result = recorder.tick(1 / 60, snapshot(standing(), (at += 1000 / 60)));
      if (result.sample) {
        produced = result.sample;
        break;
      }
    }
    expect(produced?.action).toBe('punch');
    expect(produced?.features).toHaveLength(FEATURE_DIMENSIONS);
    expect(recorder.state.phase).toBe('done');
  });

  it('says so rather than saving nothing when the camera loses you', () => {
    const recorder = new TakeRecorder();
    recorder.begin('kick', false);
    const result = tick(recorder, COUNTDOWN_SECONDS + CAPTURE_SECONDS + 0.2, null);
    expect(result.sample).toBeNull();
    expect(result.problem).toContain('lost you');
  });

  it('can be cancelled, and ignores a second start while running', () => {
    const recorder = new TakeRecorder();
    recorder.begin('punch', false);
    recorder.begin('kick', false);
    expect(recorder.state.action).toBe('punch');
    recorder.cancel();
    expect(recorder.state.phase).toBe('ready');
    expect(recorder.recording).toBe(false);
  });
});

describe('the dataset', () => {
  const sample = (action: 'punch' | 'idle', seed: number): Sample => ({
    action,
    features: Array.from({ length: FEATURE_DIMENSIONS }, (_, i) => Math.sin(i + seed) / 2),
    atMs: 1000 + seed,
  });

  it('counts what has been recorded of each action', () => {
    let data = EMPTY_DATASET;
    data = addSample(data, sample('punch', 1));
    data = addSample(data, sample('punch', 2));
    data = addSample(data, sample('idle', 3));
    expect(countsByAction(data)).toEqual({ punch: 2, idle: 1 });
  });

  it('forgets one action without touching the others', () => {
    let data = addSample(EMPTY_DATASET, sample('punch', 1));
    data = addSample(data, sample('idle', 2));
    expect(countsByAction(forgetAction(data, 'punch'))).toEqual({ idle: 1 });
  });

  it('undoes the most recent take', () => {
    let data = addSample(EMPTY_DATASET, sample('punch', 1));
    data = addSample(data, sample('idle', 2));
    expect(countsByAction(forgetLast(data))).toEqual({ punch: 1 });
  });

  it('survives a round trip through JSON', () => {
    const data = addSample(EMPTY_DATASET, sample('punch', 7));
    const back = decodeDataset(encodeDataset(data));
    expect(back.samples).toHaveLength(1);
    expect(back.samples[0]?.action).toBe('punch');
    expect(back.samples[0]?.features[3]).toBeCloseTo(sample('punch', 7).features[3] as number, 2);
  });

  it('keeps the good rows out of a damaged file rather than losing the lot', () => {
    const good = sample('punch', 1);
    const text = JSON.stringify({
      samples: [
        good,
        { action: 'not-an-action', features: good.features },
        { action: 'idle', features: [1, 2, 3] },
        { action: 'idle', features: good.features.map(() => Number.NaN) },
        'nonsense',
      ],
    });
    const back = decodeDataset(text);
    expect(back.samples).toHaveLength(1);
    expect(back.samples[0]?.action).toBe('punch');
  });

  it('reads nothing out of something that is not a dataset', () => {
    expect(decodeDataset('not json').samples).toHaveLength(0);
    expect(decodeDataset('[]').samples).toHaveLength(0);
    expect(decodeDataset('null').samples).toHaveLength(0);
  });
});

describe('the classifier', () => {
  const featuresOf = (frames: PoseSnapshot[]): number[] =>
    Array.from(windowFeature(frames) as Float64Array);

  const trained = (): GestureClassifier => {
    let data = EMPTY_DATASET;
    for (let i = 0; i < 4; i++) {
      data = addSample(data, { action: 'idle', features: featuresOf(idleFrames()), atMs: i });
      data = addSample(data, { action: 'punch', features: featuresOf(punchFrames()), atMs: i });
    }
    return new GestureClassifier(data);
  };

  it('knows nothing until it is given examples', () => {
    const empty = new GestureClassifier(EMPTY_DATASET);
    expect(empty.trained).toBe(false);
    expect(empty.classify(featuresOf(idleFrames()))).toBeNull();
  });

  it('recognises a movement it was trained on', () => {
    const verdict = trained().classify(featuresOf(punchFrames()));
    expect(verdict?.action).toBe('punch');
    expect(verdict?.confidence).toBeGreaterThan(0.5);
  });

  it('tells standing still apart from a punch', () => {
    expect(trained().classify(featuresOf(idleFrames()))?.action).toBe('idle');
  });

  it('generalises to a performance it has not seen exactly', () => {
    // The same punch, done a little further away and turned a little.
    const shifted = punchFrames().map((frame) => ({
      ...frame,
      world: turn(move(frame.world, [1.5, 0, 0.4]), 0.3),
    }));
    expect(trained().classify(featuresOf(shifted))?.action).toBe('punch');
  });

  it('says nothing rather than guessing at something unlike anything recorded', () => {
    const wild = Array.from({ length: FEATURE_DIMENSIONS }, () => MAX_DISTANCE);
    expect(trained().classify(wild)).toBeNull();
  });
});

describe('acting on verdicts', () => {
  const verdict = (action: 'punch' | 'kick' | 'idle', confidence: number) => ({
    action,
    confidence,
    distance: 1,
  });

  it('ignores a verdict it is not sure enough about', () => {
    const gate = new ActionGate(0.55, 0.5);
    expect(gate.accept(verdict('punch', 0.3), 0.016)).toBeNull();
  });

  it('fires a confident action once, not once per frame', () => {
    const gate = new ActionGate(0.55, 0.5);
    expect(gate.accept(verdict('punch', 0.9), 0.016)).toBe('punch');
    expect(gate.accept(verdict('punch', 0.9), 0.016)).toBeNull();
  });

  it('lets the same action fire again after its delay', () => {
    const gate = new ActionGate(0.55, 0.5);
    expect(gate.accept(verdict('punch', 0.9), 0.016)).toBe('punch');
    expect(gate.accept(verdict('punch', 0.9), 0.016)).toBeNull();
    expect(gate.accept(verdict('punch', 0.9), 0.6)).toBe('punch');
  });

  it('lets a different action through immediately', () => {
    const gate = new ActionGate(0.55, 0.5);
    expect(gate.accept(verdict('punch', 0.9), 0.016)).toBe('punch');
    expect(gate.accept(verdict('kick', 0.9), 0.016)).toBe('kick');
  });

  it('treats idle as a state, and lets it clear the way for a repeat', () => {
    const gate = new ActionGate(0.55, 0.5);
    gate.accept(verdict('punch', 0.9), 0.016);
    expect(gate.accept(verdict('idle', 0.9), 0.016)).toBe('idle');
    expect(gate.accept(verdict('punch', 0.9), 0.016)).toBe('punch');
  });

  it('does nothing with nothing', () => {
    expect(new ActionGate().accept(null, 0.016)).toBeNull();
  });
});

describe('the action vocabulary', () => {
  it('matches the controls a fight understands', () => {
    for (const name of ['idle', 'guard', 'jump', 'punch', 'kick', 'sweep', 'uppercut']) {
      expect(isActionName(name)).toBe(true);
    }
    expect(isActionName('backflip')).toBe(false);
  });

  it('gives every action a hint and its own colour', () => {
    for (const action of ACTIONS) {
      expect(action.hint.length).toBeGreaterThan(10);
      expect(action.accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
