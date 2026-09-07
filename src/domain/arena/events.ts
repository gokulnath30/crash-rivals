/**
 * Which corner something happened to. Ashen Ring is always a duel, so this is
 * a fixed pair rather than a seat number.
 */
export type BrawlerIndex = 0 | 1;

export const otherBrawler = (index: BrawlerIndex): BrawlerIndex => (index === 0 ? 1 : 0);

export type AttackName = 'punch' | 'kick' | 'sweep' | 'uppercut' | 'air-kick';

/**
 * Everything the fight wants the outside world to know about, as plain data.
 *
 * The rules emit these; the renderer, the HUD and the mixer each pick out the
 * ones they care about. Nothing in the domain knows any of them exist.
 */
export type ArenaEvent =
  | { readonly kind: 'attack'; readonly attacker: BrawlerIndex; readonly move: AttackName }
  | {
      readonly kind: 'hit';
      readonly attacker: BrawlerIndex;
      readonly defender: BrawlerIndex;
      readonly move: AttackName;
      readonly damage: number;
      readonly blocked: boolean;
      /** True when this blow ended the round. */
      readonly knockdown: boolean;
      /** World-space point of contact, for sparks and damage numbers. */
      readonly x: number;
      readonly y: number;
    }
  | { readonly kind: 'whiff'; readonly attacker: BrawlerIndex; readonly move: AttackName }
  | { readonly kind: 'round-start'; readonly round: number }
  | { readonly kind: 'fight-call' }
  | {
      readonly kind: 'round-end';
      readonly winner: BrawlerIndex | null;
      readonly round: number;
      readonly wins: readonly [number, number];
      readonly matchOver: boolean;
    }
  | { readonly kind: 'announce'; readonly text: string; readonly holdMs: number };

export const NO_EVENTS: readonly ArenaEvent[] = Object.freeze([]);
