import type {
  AudioPort,
  MusicTrack,
  PlayOptions,
  SoundCue,
} from '@app/ports/audio.port.ts';
import type { LoggerPort } from '@app/ports/logger.port.ts';
import { createArenaImpulse, createNoiseBuffer } from './impulse.ts';
import { MusicSequencer } from './music.ts';
import { VOICES, type VoiceContext } from './voices.ts';

/**
 * The mixer.
 *
 *   voice ──▶ panner ──▶ sfx bus ──┐
 *                                  ├─▶ compressor ──▶ master ──▶ speakers
 *   music ──▶ music bus ───────────┘         ▲
 *                                            │
 *   reverb send ──▶ convolver ──▶ reverb bus ┘
 *
 * The compressor is the piece that makes it sound like a game rather than a
 * pile of oscillators: a knockout and four simultaneous punches would
 * otherwise clip, and quiet UI blips would vanish under the music. Music runs
 * *into* the compressor too, so hits duck it automatically as well as through
 * the explicit `duck` call.
 */
export class WebAudioAdapter implements AudioPort {
  muted = false;
  unlocked = false;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private reverbSend: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private sequencer: MusicSequencer | null = null;
  private pendingTrack: MusicTrack | null = null;
  /** How many voices started in the current window, to survive a spam of hits. */
  private recentVoices = 0;
  private windowStartedAt = 0;
  private readonly log: LoggerPort;

  constructor(logger: LoggerPort) {
    this.log = logger.scoped('audio');
  }

  /**
   * Browsers will not let a page make a sound until the user has interacted
   * with it, so this must be called from a real click or keypress. Calling it
   * again later is free.
   */
  async unlock(): Promise<void> {
    try {
      const ctx = this.ensureContext();
      if (ctx.state === 'suspended') await ctx.resume();
      this.unlocked = ctx.state === 'running';
      if (this.unlocked && this.pendingTrack) {
        const track = this.pendingTrack;
        this.pendingTrack = null;
        this.startMusic(track);
      }
    } catch (error: unknown) {
      this.log.log('warn', 'could not start the audio context', error);
    }
  }

  play(cue: SoundCue, options: PlayOptions = {}): void {
    const ctx = this.ctx;
    if (!ctx || this.muted || ctx.state !== 'running') return;
    if (!this.withinVoiceBudget()) return;

    const sfxBus = this.sfxBus;
    const reverbSend = this.reverbSend;
    const noise = this.noise;
    if (!sfxBus || !reverbSend || !noise) return;

    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(options.pan ?? 0, -1, 1);
    panner.connect(sfxBus);

    const voice: VoiceContext = {
      ctx,
      out: panner,
      reverb: reverbSend,
      noise,
      // A hair into the future: scheduling at exactly `currentTime` can be
      // slightly late by the time the graph is built, which clicks.
      at: ctx.currentTime + 0.005,
      intensity: clamp(options.intensity ?? 0.6, 0, 1),
    };

    try {
      VOICES[cue](voice);
    } catch (error: unknown) {
      this.log.log('warn', `voice ${cue} failed`, error);
    }
  }

  startMusic(track: MusicTrack): void {
    if (!this.unlocked) {
      // Remember the intent; `unlock` will pick it up on the first gesture.
      this.pendingTrack = track;
      return;
    }
    this.ensureContext();
    if (this.muted) {
      this.pendingTrack = track;
      return;
    }
    this.sequencer?.start(track);
  }

  stopMusic(fadeSeconds = 0.6): void {
    this.pendingTrack = null;
    this.sequencer?.stop(fadeSeconds);
  }

  /**
   * Pulls the music down and lets it come back, so a knockout is not competing
   * with a bassline.
   */
  duck(amount: number, seconds: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;

    const floor = clamp(1 - amount, 0, 1) * MUSIC_LEVEL;
    const now = ctx.currentTime;
    bus.gain.cancelScheduledValues(now);
    bus.gain.setValueAtTime(bus.gain.value, now);
    bus.gain.linearRampToValueAtTime(floor, now + 0.04);
    bus.gain.linearRampToValueAtTime(MUSIC_LEVEL, now + 0.04 + Math.max(0.05, seconds));
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(muted ? 0 : MASTER_LEVEL, now + 0.12);

    if (muted) {
      this.pendingTrack = this.sequencer?.playing ?? this.pendingTrack;
      this.sequencer?.stop(0.15);
    } else if (this.pendingTrack) {
      const track = this.pendingTrack;
      this.pendingTrack = null;
      this.startMusic(track);
    }
  }

  dispose(): void {
    this.sequencer?.dispose();
    this.sequencer = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.reverbSend = null;
    this.unlocked = false;
  }

  /** Builds the graph on first use, not on import. */
  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;

    const Constructor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Constructor({ latencyHint: 'interactive' });
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : MASTER_LEVEL;

    // Fast attack to catch transients, slow-ish release so it breathes.
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 22;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;

    const sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.9;

    const musicBus = ctx.createGain();
    musicBus.gain.value = MUSIC_LEVEL;

    const convolver = ctx.createConvolver();
    convolver.buffer = createArenaImpulse(ctx);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.5;
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 1;

    reverbSend.connect(convolver).connect(reverbReturn).connect(compressor);
    sfxBus.connect(compressor);
    musicBus.connect(compressor);
    compressor.connect(master).connect(ctx.destination);

    this.master = master;
    this.sfxBus = sfxBus;
    this.musicBus = musicBus;
    this.reverbSend = reverbSend;
    this.noise = createNoiseBuffer(ctx);
    this.sequencer = new MusicSequencer(ctx, musicBus, this.noise);

    return ctx;
  }

  /**
   * A cap on how many voices may start in a short window.
   *
   * Without it, a tracking glitch that fires forty punches in one second would
   * build forty audio graphs and audibly stall the frame. The cap is generous
   * enough that real play never reaches it.
   */
  private withinVoiceBudget(): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const now = ctx.currentTime;
    if (now - this.windowStartedAt > VOICE_WINDOW_SECONDS) {
      this.windowStartedAt = now;
      this.recentVoices = 0;
    }
    if (this.recentVoices >= MAX_VOICES_PER_WINDOW) return false;
    this.recentVoices += 1;
    return true;
  }
}

const MASTER_LEVEL = 0.9;
const MUSIC_LEVEL = 0.32;
const VOICE_WINDOW_SECONDS = 0.25;
const MAX_VOICES_PER_WINDOW = 14;

const clamp = (value: number, lo: number, hi: number): number =>
  value < lo ? lo : value > hi ? hi : value;
