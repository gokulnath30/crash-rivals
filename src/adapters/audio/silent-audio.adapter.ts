import type { AudioPort, MusicTrack, PlayOptions, SoundCue } from '@app/ports/audio.port.ts';

/**
 * An `AudioPort` that does nothing.
 *
 * A null object rather than sprinkling `audio?.play(...)` through the game
 * loop: the game always has a mixer, it just might be a mixer that stays
 * quiet. Used in tests and anywhere Web Audio is unavailable.
 */
export class SilentAudioAdapter implements AudioPort {
  readonly muted = true;
  readonly unlocked = false;

  /** Records what was asked for, which makes it useful as a test spy. */
  readonly played: { cue: SoundCue; options: PlayOptions }[] = [];

  async unlock(): Promise<void> {
    /* nothing to unlock */
  }

  play(cue: SoundCue, options: PlayOptions = {}): void {
    this.played.push({ cue, options });
  }

  startMusic(_track: MusicTrack): void {
    /* silence */
  }

  stopMusic(_fadeSeconds?: number): void {
    /* silence */
  }

  duck(_amount: number, _seconds: number): void {
    /* silence */
  }

  setMuted(_muted: boolean): void {
    /* always muted */
  }

  dispose(): void {
    this.played.length = 0;
  }
}
