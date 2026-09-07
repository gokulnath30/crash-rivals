import type { MusicTrack } from '@app/ports/audio.port.ts';

/**
 * The soundtrack: a step sequencer, scheduled ahead of the clock.
 *
 * Web Audio's timers are the wrong tool for music — `setInterval` drifts and
 * jitters audibly. The standard answer, and the one used here, is a lookahead
 * scheduler: a coarse timer wakes up every `TICK_MS`, works out which steps
 * fall inside the next `LOOKAHEAD` seconds, and schedules them at exact
 * `AudioContext` times. The audio clock keeps the beat; the timer only has to
 * be roughly punctual.
 */

const TICK_MS = 60;
const LOOKAHEAD = 0.35;
const STEPS_PER_BAR = 16;

/** A step pattern: which sixteenths fire, and at what velocity. */
type Pattern = readonly number[];

interface TrackScore {
  readonly bpm: number;
  /** Root notes, one per bar, cycled. */
  readonly bassline: readonly number[];
  /** Chord voicings above the root, as semitone offsets. */
  readonly chord: readonly number[];
  readonly bass: Pattern;
  readonly kick: Pattern;
  readonly hat: Pattern;
  /** How present the pad is. The fight theme wants almost none. */
  readonly padLevel: number;
  readonly bassLevel: number;
}

const A2 = 110;
const semitone = (root: number, steps: number): number => root * Math.pow(2, steps / 12);

const SCORES: Readonly<Record<MusicTrack, TrackScore>> = {
  /** Slow, wide, patient — it sits under a menu without demanding attention. */
  menu: {
    bpm: 84,
    bassline: [A2, semitone(A2, -4), semitone(A2, 3), semitone(A2, -2)],
    chord: [0, 7, 12, 15],
    bass: [1, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0],
    kick: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    hat: [0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0, 0, 0, 0.25, 0, 0, 0],
    padLevel: 0.5,
    bassLevel: 0.35,
  },
  /** Driving and repetitive. It is there to raise the pulse, not to be admired. */
  fight: {
    bpm: 132,
    bassline: [A2, A2, semitone(A2, 5), semitone(A2, 3)],
    chord: [0, 7, 10],
    bass: [1, 0, 0.7, 0, 0.85, 0, 0.7, 0, 1, 0, 0.7, 0, 0.85, 0, 0.9, 0.6],
    kick: [1, 0, 0, 0, 0.8, 0, 0, 0, 1, 0, 0, 0.5, 0.8, 0, 0, 0],
    hat: [0, 0.3, 0.5, 0.3, 0, 0.3, 0.5, 0.3, 0, 0.3, 0.5, 0.3, 0, 0.3, 0.6, 0.4],
    padLevel: 0.16,
    bassLevel: 0.5,
  },
  victory: {
    bpm: 108,
    bassline: [semitone(A2, 5), semitone(A2, 12), semitone(A2, 7), semitone(A2, 5)],
    chord: [0, 4, 7, 11],
    bass: [1, 0, 0, 0.6, 0, 0, 0.8, 0, 1, 0, 0, 0.6, 0, 0, 0.7, 0],
    kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    hat: [0, 0, 0.4, 0, 0, 0, 0.4, 0, 0, 0, 0.4, 0, 0, 0, 0.5, 0.4],
    padLevel: 0.55,
    bassLevel: 0.4,
  },
};

export class MusicSequencer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private score: TrackScore | null = null;
  private current: MusicTrack | null = null;
  private step = 0;
  private nextStepAt = 0;
  /** Voices scheduled but not yet finished, so `stop` can silence them. */
  private scheduled: { stopAt: number; stop: () => void }[] = [];

  constructor(
    private readonly ctx: AudioContext,
    private readonly out: AudioNode,
    private readonly noise: AudioBuffer,
  ) {}

  get playing(): MusicTrack | null {
    return this.current;
  }

  start(track: MusicTrack): void {
    if (this.current === track) return;
    this.stop(0.25);
    this.score = SCORES[track];
    this.current = track;
    this.step = 0;
    this.nextStepAt = this.ctx.currentTime + 0.08;
    this.timer = setInterval(() => {
      this.schedule();
    }, TICK_MS);
    this.schedule();
  }

  /**
   * Stops the sequencer and lets whatever is already sounding ring out, rather
   * than cutting it dead — an abrupt stop reads as a bug.
   */
  stop(fadeSeconds = 0.6): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.current = null;
    this.score = null;

    const cutoff = this.ctx.currentTime + Math.max(0, fadeSeconds);
    for (const voice of this.scheduled) {
      if (voice.stopAt > cutoff) voice.stop();
    }
    this.scheduled = [];
  }

  dispose(): void {
    this.stop(0);
  }

  private schedule(): void {
    const score = this.score;
    if (!score) return;

    const stepSeconds = 60 / score.bpm / 4;
    const horizon = this.ctx.currentTime + LOOKAHEAD;

    while (this.nextStepAt < horizon) {
      this.playStep(score, this.step, this.nextStepAt, stepSeconds);
      this.nextStepAt += stepSeconds;
      this.step = (this.step + 1) % (STEPS_PER_BAR * score.bassline.length);
    }

    // Forget voices that have already finished, so the list cannot grow
    // without bound over a long menu sit.
    const now = this.ctx.currentTime;
    this.scheduled = this.scheduled.filter((voice) => voice.stopAt > now);
  }

  private playStep(score: TrackScore, step: number, at: number, stepSeconds: number): void {
    const bar = Math.floor(step / STEPS_PER_BAR) % score.bassline.length;
    const inBar = step % STEPS_PER_BAR;
    const root = score.bassline[bar] ?? A2;

    const bassVelocity = score.bass[inBar] ?? 0;
    if (bassVelocity > 0) {
      this.pluck({
        frequency: root,
        at,
        duration: stepSeconds * 1.8,
        peak: bassVelocity * score.bassLevel,
        type: 'sawtooth',
        cutoff: 420,
      });
    }

    const kickVelocity = score.kick[inBar] ?? 0;
    if (kickVelocity > 0) this.drum({ at, peak: kickVelocity * 0.5, low: true });

    const hatVelocity = score.hat[inBar] ?? 0;
    if (hatVelocity > 0) this.drum({ at, peak: hatVelocity * 0.16, low: false });

    // The pad re-voices once per bar and holds.
    if (inBar === 0 && score.padLevel > 0) {
      const barSeconds = stepSeconds * STEPS_PER_BAR;
      for (const offset of score.chord) {
        this.pluck({
          frequency: semitone(root * 2, offset),
          at,
          duration: barSeconds * 1.05,
          peak: (score.padLevel * 0.22) / score.chord.length,
          type: 'triangle',
          cutoff: 1800,
          attack: barSeconds * 0.25,
        });
      }
    }
  }

  private pluck(options: {
    frequency: number;
    at: number;
    duration: number;
    peak: number;
    type: OscillatorType;
    cutoff: number;
    attack?: number;
  }): void {
    const { ctx } = this;
    const osc = ctx.createOscillator();
    osc.type = options.type;
    osc.frequency.value = options.frequency;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = options.cutoff;
    filter.Q.value = 0.7;

    const gain = ctx.createGain();
    const attack = options.attack ?? 0.008;
    gain.gain.setValueAtTime(0.0001, options.at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, options.peak), options.at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, options.at + options.duration);

    osc.connect(filter).connect(gain).connect(this.out);
    osc.start(options.at);
    const stopAt = options.at + options.duration + 0.05;
    osc.stop(stopAt);
    this.remember(stopAt, () => {
      // Ramp to silence rather than calling stop() early, which clicks.
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08);
    });
  }

  private drum(options: { at: number; peak: number; low: boolean }): void {
    const { ctx } = this;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    const duration = options.low ? 0.16 : 0.045;
    if (options.low) {
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(900, options.at);
      filter.frequency.exponentialRampToValueAtTime(60, options.at + duration);
    } else {
      filter.type = 'highpass';
      filter.frequency.value = 7000;
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, options.at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, options.peak), options.at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, options.at + duration);

    source.connect(filter).connect(gain).connect(this.out);
    source.start(options.at, Math.random() * (this.noise.duration - duration - 0.01));
    const stopAt = options.at + duration + 0.03;
    source.stop(stopAt);

    if (options.low) {
      // A pitched layer under the noise gives the kick a note to sit on.
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(140, options.at);
      osc.frequency.exponentialRampToValueAtTime(45, options.at + duration);
      const body = ctx.createGain();
      body.gain.setValueAtTime(0.0001, options.at);
      body.gain.exponentialRampToValueAtTime(options.peak * 1.4, options.at + 0.005);
      body.gain.exponentialRampToValueAtTime(0.0001, options.at + duration);
      osc.connect(body).connect(this.out);
      osc.start(options.at);
      osc.stop(stopAt);
    }

    this.remember(stopAt, () => {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
    });
  }

  private remember(stopAt: number, stop: () => void): void {
    this.scheduled.push({ stopAt, stop });
  }
}
