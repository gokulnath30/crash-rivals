import type { GameDefinition } from '@domain/catalog/game-definition.ts';
import type { GameId } from '@domain/shared/ids.ts';

/**
 * The shelf. Synchronous on purpose: the catalogue is part of the build, so
 * the store paints instantly instead of showing a spinner over a list of four
 * games that were never going to change.
 */
export interface GameCatalogPort {
  all(): readonly GameDefinition[];
  find(id: GameId): GameDefinition | null;
  byTag(tag: string): readonly GameDefinition[];
  tags(): readonly string[];
}
