import type { SoundCue } from '@app/ports/audio.port.ts';

/**
 * The synthesiser: one function per sound, built from oscillators and noise.
 *
 * Nothing here loads a file. Every sound is a shaped envelope over a couple of
 * oscillators and a filtered noise burst, which is why the whole game's audio
 * costs nothing to download and works offline.
 *
 * The shared vocabulary:
 *   - a *thump* is the low body of an impact, pitched down fast
 *   - a *slap* is the bright transient that makes it read as skin, not a drum
 *   - a *tail* is what the reverb send does with it
 */
export interface VoiceContext {
  readonly ctx: AudioContext;
  /** The dry bus for this sound (already panned). */
  readonly out: AudioNode;
  /** The reverb send. Voices decide how wet they want to be. */
  readonly reverb: AudioNode;
  readonly noise: AudioBuffer;
  readonly at: number;
  /** 0..1, how hard this instance hits. */
  readonly intensity: number;
}

export type Voice = (voice: VoiceContext) => void;

/** All the shaping helpers take `at` so a voice can schedule ahead of now. */

function envelope(
  ctx: AudioContext,
  at: number,
  peak: number,
  attack: number,
  decay: number,
): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  return gain;
}

function tone(
  ctx: AudioContext,
  options: {
    type: OscillatorType;
    from: number;
    to?: number;
    at: number;
    duration: number;
  },
): OscillatorNode {
  const osc = ctx.createOscillator();
  osc.type = options.type;
  osc.frequency.setValueAtTime(options.from, options.at);
  if (options.to !== undefined && options.to !== options.from) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(1, options.to),
      options.at + options.duration,
    );
  }
  osc.start(options.at);
  osc.stop(options.at + options.duration + 0.02);
  return osc;
}

function noiseBurst(
  voice: VoiceContext,
  options: {
    type: BiquadFilterType;
    frequency: number;
    sweepTo?: number;
    q?: number;
    duration: number;
    peak: number;
    attack?: number;
  },
): AudioNode {
  const { ctx, at } = voice;
  const source = ctx.createBufferSource();
  source.buffer = voice.noise;
  // A random offset into the shared noise buffer, so twenty punches in a row
  // are twenty different noises rather than one noise twenty times.
  source.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = options.type;
  filter.frequency.setValueAtTime(options.frequency, at);
  if (options.sweepTo !== undefined) {
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(20, options.sweepTo),
      at + options.duration,
    );
  }
  filter.Q.value = options.q ?? 1;

  const gain = envelope(ctx, at, options.peak, options.attack ?? 0.004, options.duration);
  source.connect(filter).connect(gain);
  // The buffer loops, so a burst longer than the buffer simply starts at its
  // head rather than at a negative offset, which the browser rejects.
  source.start(at, Math.random() * Math.max(0, voice.noise.duration - options.duration - 0.01));
  source.stop(at + options.duration + 0.05);
  return gain;
}

/** Sends a portion of a voice to the arena reverb. */
function wet(voice: VoiceContext, node: AudioNode, amount: number): void {
  const send = voice.ctx.createGain();
  send.gain.value = amount;
  node.connect(send).connect(voice.reverb);
}

// ---------------------------------------------------------------- impacts

/**
 * A punch: low thump for weight, mid noise for the flesh of it, and a short
 * bright tick so it cuts through the music.
 */
const punch =
  (weight: 'light' | 'heavy'): Voice =>
  (voice) => {
    const { ctx, out, at, intensity } = voice;
    const heavy = weight === 'heavy';
    const gain = 0.35 + intensity * 0.45;

    const thumpFrom = heavy ? 150 : 200;
    const thumpTo = heavy ? 42 : 70;
    const duration = heavy ? 0.3 : 0.19;

    const body = envelope(ctx, at, gain, 0.005, duration);
    tone(ctx, { type: 'sine', from: thumpFrom, to: thumpTo, at, duration }).connect(body);
    body.connect(out);
    wet(voice, body, heavy ? 0.3 : 0.18);

    const slap = noiseBurst(voice, {
      type: 'bandpass',
      frequency: heavy ? 900 : 1500,
      q: 0.9,
      duration: heavy ? 0.14 : 0.09,
      peak: gain * (heavy ? 0.7 : 0.55),
    });
    slap.connect(out);
    wet(voice, slap, 0.22);

    // The click that gives it edge on small speakers.
    const tick = envelope(ctx, at, gain * 0.25, 0.002, 0.035);
    tone(ctx, { type: 'triangle', from: heavy ? 420 : 620, to: 180, at, duration: 0.035 }).connect(
      tick,
    );
    tick.connect(out);
  };

/** A kick: everything a heavy punch has, an octave lower and with more room. */
const kick: Voice = (voice) => {
  const { ctx, out, at, intensity } = voice;
  const gain = 0.45 + intensity * 0.5;

  const body = envelope(ctx, at, gain, 0.006, 0.4);
  tone(ctx, { type: 'sine', from: 130, to: 32, at, duration: 0.4 }).connect(body);
  // A second, detuned layer an octave up thickens it without raising the pitch.
  tone(ctx, { type: 'triangle', from: 260, to: 64, at, duration: 0.22 }).connect(body);
  body.connect(out);
  wet(voice, body, 0.42);

  const impact = noiseBurst(voice, {
    type: 'lowpass',
    frequency: 2600,
    sweepTo: 400,
    duration: 0.2,
    peak: gain * 0.8,
  });
  impact.connect(out);
  wet(voice, impact, 0.3);
};

/** A block: metal on metal, tight and bright, with almost no low end. */
const block: Voice = (voice) => {
  const { ctx, out, at, intensity } = voice;
  const gain = 0.22 + intensity * 0.22;

  const ring = envelope(ctx, at, gain, 0.002, 0.16);
  // Two close partials beating against each other read as "metallic".
  tone(ctx, { type: 'square', from: 1180, at, duration: 0.16 }).connect(ring);
  tone(ctx, { type: 'square', from: 1570, at, duration: 0.12 }).connect(ring);
  const shape = ctx.createBiquadFilter();
  shape.type = 'highpass';
  shape.frequency.value = 700;
  ring.connect(shape).connect(out);
  wet(voice, shape, 0.35);

  const scrape = noiseBurst(voice, {
    type: 'bandpass',
    frequency: 3200,
    q: 1.6,
    duration: 0.07,
    peak: gain * 0.9,
  });
  scrape.connect(out);
};

/** A miss: air moving. Nothing but a swept noise band, no pitch at all. */
const whiff: Voice = (voice) => {
  const swoosh = noiseBurst(voice, {
    type: 'bandpass',
    frequency: 380,
    sweepTo: 2400,
    q: 1.1,
    duration: 0.22,
    peak: 0.14 + voice.intensity * 0.12,
    attack: 0.05,
  });
  swoosh.connect(voice.out);
  wet(voice, swoosh, 0.12);
};

/** Gloves coming up: soft, cloth-like, no transient. */
const guardUp: Voice = (voice) => {
  const thud = noiseBurst(voice, {
    type: 'lowpass',
    frequency: 700,
    duration: 0.12,
    peak: 0.16,
    attack: 0.02,
  });
  thud.connect(voice.out);
};

// ---------------------------------------------------------------- the match

/**
 * A knockout: the low end drops out from under the fight, the room rings, and
 * the crowd comes up underneath it.
 */
const knockout: Voice = (voice) => {
  const { ctx, out, at } = voice;

  const drop = envelope(ctx, at, 0.85, 0.01, 1.5);
  tone(ctx, { type: 'sine', from: 220, to: 24, at, duration: 1.5 }).connect(drop);
  drop.connect(out);
  wet(voice, drop, 0.7);

  const slam = noiseBurst(voice, {
    type: 'lowpass',
    frequency: 3000,
    sweepTo: 180,
    duration: 0.5,
    peak: 0.6,
  });
  slam.connect(out);
  wet(voice, slam, 0.8);

  // The crowd, arriving a beat later as it would in a real room.
  const crowdVoice: VoiceContext = { ...voice, at: at + 0.12, intensity: 1 };
  crowd(crowdVoice);
};

/** A ring bell: a struck FM-ish tone with inharmonic partials. */
const bell =
  (root: number): Voice =>
  (voice) => {
    const { ctx, out, at } = voice;
    // Inharmonic ratios are what separate a bell from an organ note.
    for (const [ratio, level, decay] of [
      [1, 0.5, 1.6],
      [2.76, 0.24, 1.1],
      [5.4, 0.12, 0.7],
      [8.9, 0.06, 0.45],
    ] as const) {
      const partial = envelope(ctx, at, level * (0.5 + voice.intensity * 0.5), 0.003, decay);
      tone(ctx, { type: 'sine', from: root * ratio, at, duration: decay }).connect(partial);
      partial.connect(out);
      wet(voice, partial, 0.5);
    }
  };

/** A crowd: band-limited noise with a slow swell. No voices, just a roar. */
const crowd: Voice = (voice) => {
  const roar = noiseBurst(voice, {
    type: 'bandpass',
    frequency: 620,
    sweepTo: 900,
    q: 0.6,
    duration: 1.7,
    peak: 0.12 + voice.intensity * 0.16,
    attack: 0.25,
  });
  roar.connect(voice.out);
  wet(voice, roar, 0.9);
};

/** A short melodic figure, used for wins, losses and UI confirmation. */
const figure =
  (notes: readonly number[], step: number, peak: number, type: OscillatorType = 'triangle'): Voice =>
  (voice) => {
    const { ctx, out, at } = voice;
    notes.forEach((frequency, index) => {
      const start = at + index * step;
      const gain = envelope(ctx, start, peak, 0.01, step * 1.9);
      tone(ctx, { type, from: frequency, at: start, duration: step * 1.9 }).connect(gain);
      gain.connect(out);
      wet(voice, gain, 0.3);
    });
  };

/** A UI blip: one short tone, no reverb, deliberately unmusical. */
const blip =
  (frequency: number, duration = 0.06, peak = 0.13, type: OscillatorType = 'square'): Voice =>
  (voice) => {
    const { ctx, out, at } = voice;
    const gain = envelope(ctx, at, peak, 0.002, duration);
    tone(ctx, { type, from: frequency, at, duration }).connect(gain);
    const soften = ctx.createBiquadFilter();
    soften.type = 'lowpass';
    soften.frequency.value = 3200;
    gain.connect(soften).connect(out);
  };

/**
 * The whole vocabulary, resolved. Adding a cue means adding it to `SoundCue`
 * and to this table — and the compiler insists on the second half.
 */
export const VOICES: Readonly<Record<SoundCue, Voice>> = {
  'punch-light': punch('light'),
  'punch-heavy': punch('heavy'),
  kick,
  block,
  whiff,
  'guard-up': guardUp,
  knockout,
  'bell-start': bell(660),
  'bell-end': bell(494),
  'crowd-swell': crowd,
  'countdown-tick': blip(880, 0.05, 0.1),
  'match-won': figure([523, 659, 784, 1047], 0.11, 0.24),
  'match-lost': figure([392, 330, 262, 196], 0.15, 0.2, 'sawtooth'),
  'ui-move': blip(420, 0.035, 0.07),
  'ui-confirm': figure([587, 880], 0.06, 0.12),
  'ui-back': figure([440, 294], 0.06, 0.1),
  'ui-error': blip(180, 0.14, 0.14, 'sawtooth'),
  'peer-joined': figure([523, 784], 0.09, 0.16),
  'peer-left': figure([494, 330], 0.11, 0.14, 'sine'),
};
