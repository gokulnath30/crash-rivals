/**
 * Branded string ids. `PlayerId` and `MatchId` are both strings at runtime but
 * the compiler refuses to swap one for the other, which is exactly the mistake
 * that is otherwise invisible in a lobby full of ids.
 */
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type PlayerId = Brand<string, 'PlayerId'>;
export type MatchId = Brand<string, 'MatchId'>;
export type GameId = Brand<string, 'GameId'>;

export const asPlayerId = (raw: string): PlayerId => raw as PlayerId;
export const asMatchId = (raw: string): MatchId => raw as MatchId;
export const asGameId = (raw: string): GameId => raw as GameId;
