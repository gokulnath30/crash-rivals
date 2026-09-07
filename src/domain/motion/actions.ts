/**
 * The actions a body can be taught to mean.
 *
 * Deliberately the same vocabulary the fighting game already understands, so
 * a model trained here can drive a fight without a translation table in
 * between. Held states and struck gestures are both here: the classifier
 * tells them apart by what it was trained on, not by kind.
 */
export type ActionName =
  | 'idle'
  | 'guard'
  | 'move-left'
  | 'move-right'
  | 'jump'
  | 'punch'
  | 'kick'
  | 'sweep'
  | 'uppercut';

export interface ActionSpec {
  readonly name: ActionName;
  /** What to show the person recording. */
  readonly label: string;
  /** How to perform it, in one line. */
  readonly hint: string;
  /**
   * A held pose (guard, standing still) rather than a movement. Held actions
   * are easy to record and easy to recognise; struck ones need the window to
   * catch the movement, so they are recorded over a longer capture.
   */
  readonly held: boolean;
  /** CSS colour, so each action reads as itself throughout the room. */
  readonly accent: string;
}

export const ACTIONS: readonly ActionSpec[] = [
  {
    name: 'idle',
    label: 'Idle',
    hint: 'Stand in your fighting stance and do nothing. Record this first.',
    held: true,
    accent: '#8b93a7',
  },
  {
    name: 'guard',
    label: 'Guard',
    hint: 'Both hands up by your face, elbows in.',
    held: true,
    accent: '#e8c27a',
  },
  {
    name: 'move-left',
    label: 'Move left',
    hint: 'Step to your left and hold it.',
    held: true,
    accent: '#7ee0c0',
  },
  {
    name: 'move-right',
    label: 'Move right',
    hint: 'Step to your right and hold it.',
    held: true,
    accent: '#7ec0e0',
  },
  {
    name: 'jump',
    label: 'Jump',
    hint: 'Bend and leap, or lift both knees sharply.',
    held: false,
    accent: '#b98cff',
  },
  {
    name: 'punch',
    label: 'Punch',
    hint: 'Throw a straight punch and bring the hand back.',
    held: false,
    accent: '#ff6a2a',
  },
  {
    name: 'kick',
    label: 'Kick',
    hint: 'Lift the knee and drive the foot forward.',
    held: false,
    accent: '#58c9ff',
  },
  {
    name: 'sweep',
    label: 'Sweep',
    hint: 'Crouch and swing a leg low across the floor.',
    held: false,
    accent: '#ff5f8f',
  },
  {
    name: 'uppercut',
    label: 'Uppercut',
    hint: 'Dip, then drive a fist upward past your chin.',
    held: false,
    accent: '#ffd166',
  },
];

export const ACTION_NAMES: readonly ActionName[] = ACTIONS.map((action) => action.name);

export function findAction(name: string): ActionSpec | null {
  return ACTIONS.find((action) => action.name === name) ?? null;
}

export const isActionName = (value: string): value is ActionName =>
  ACTION_NAMES.includes(value as ActionName);

/**
 * How many examples of an action make it worth trusting.
 *
 * Not a hard rule the code enforces, but the number the room asks for: below
 * this a class is usually recognised only from the exact spot you stood in.
 */
export const SAMPLES_WANTED = 8;
