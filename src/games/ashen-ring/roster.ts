/**
 * The fighters of Ashen Ring.
 *
 * A model is only ever a skin. Reach, damage and timing all come from the
 * rules in `@domain/arena`, so choosing a fighter cannot make you better at
 * the game. Two entries share the same export and are told apart by what
 * they wear.
 */
export type RosterId = 'sable' | 'kestrel' | 'orin';

export interface RosterEntry {
  readonly id: RosterId;
  readonly name: string;
  /** One line under the name on the select screen. */
  readonly blurb: string;
  /** Path to the model, relative to the deployed base. */
  readonly model: string;
  /**
   * Multiplied into the outfit's material only, never the skin. `null` keeps
   * the export exactly as it was.
   */
  readonly outfit: number | null;
  /** Whether the export's eyewear is shown. */
  readonly eyewear: boolean;
  /** CSS colour for the select screen. */
  readonly accent: string;
}

export const ROSTER: readonly RosterEntry[] = [
  {
    id: 'sable',
    name: 'Sable',
    blurb: 'Counter-puncher. Waits, then does not. The detailed build, 13 MB.',
    // The detailed Avaturn export, dressed for the ring. Heavier than the
    // light export the others share, and worth it: this is the fighter the
    // portraits look at most.
    model: 'characters/sable.glb',
    outfit: null,
    eyewear: true,
    accent: '#ff6a2a',
  },
  {
    id: 'kestrel',
    name: 'Kestrel',
    blurb: 'Kicks first, asks nothing.',
    model: 'characters/fighter-a.glb',
    outfit: 0x4a6f9e,
    eyewear: false,
    accent: '#58c9ff',
  },
  {
    id: 'orin',
    name: 'Orin',
    blurb: 'The detailed build. 13 MB, worth it up close.',
    model: 'characters/trainer-a.glb',
    outfit: null,
    eyewear: false,
    accent: '#e8c27a',
  },
];

export const DEFAULT_PICK: RosterId = 'sable';

export function findRoster(id: string | null): RosterEntry {
  return (
    ROSTER.find((entry) => entry.id === id) ??
    ROSTER.find((entry) => entry.id === DEFAULT_PICK) ??
    (ROSTER[0] as RosterEntry)
  );
}

/** Someone who is not the player, so the two are told apart at a glance. */
export function rivalFor(id: RosterId): RosterEntry {
  return ROSTER.find((entry) => entry.id !== id && entry.id !== 'orin') ?? findRoster(null);
}

const STORAGE_KEY = 'ashen-ring.pick.v1';

export function readSavedPick(): RosterId {
  try {
    return findRoster(localStorage.getItem(STORAGE_KEY)).id;
  } catch {
    return DEFAULT_PICK;
  }
}

export function savePick(id: RosterId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private browsing. The choice simply will not persist.
  }
}
