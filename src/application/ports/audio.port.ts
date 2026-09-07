/**
 * Every sound the store and the games can make. A closed vocabulary rather
 * than filenames or free strings: the mixer decides how a `punch-heavy`
 * sounds, and a typo becomes a compile error instead of silence.
 */
export type SoundCue =
  | 'punch-light'
  | 'punch-heavy'
  | 'kick'
  | 'block'
  | 'whiff'
  | 'guard-up'
  | 'knockout'
  | 'bell-start'
  | 'bell-end'
  | 'crowd-swell'
  | 'countdown-tick'
  | 'match-won'
  | 'match-lost'
  | 'ui-move'
  | 'ui-confirm'
  | 'ui-back'
  | 'ui-error'
  | 'peer-joined'
  | 'peer-left';

export type MusicTrack = 'menu' | 'fight' | 'victory';

export interface PlayOptions {
  /**
   * 0..1 — how hard the sound hits. A 7-damage jab and a 20-damage kick are
   * the same cue at different intensities, which is what keeps a fight from
   * sounding like a drum machine.
   */
  readonly intensity?: number;
  /** -1 fully left, 0 centre, 1 fully right. Follows the action on screen. */
  readonly pan?: number;
}

/**
 * The mixer. Browsers refuse to start audio without a user gesture, hence
 * `unlock` — call it from the click that starts the game, not on load.
 */
export interface AudioPort {
  readonly muted: boolean;
  /** True once the browser has actually let us make a sound. */
  readonly unlocked: boolean;

  unlock(): Promise<void>;
  play(cue: SoundCue, options?: PlayOptions): void;
  startMusic(track: MusicTrack): void;
  stopMusic(fadeSeconds?: number): void;
  /** Momentarily pulls the music down so a hit can be heard over it. */
  duck(amount: number, seconds: number): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}
