import { GAME_IDS } from '@adapters/catalog/static-catalog.adapter.ts';
import { ok, type Result } from '@domain/shared/result.ts';
import type { GameContext, GameHandle, GameRuntime } from '@app/ports/game-runtime.port.ts';
import { AshenRingSession } from './session.ts';

/**
 * Ashen Ring as the store sees it: a keyboard fighting game with two realistic
 * fighters in a ring of fire. Solo against the machine, or two players sharing
 * one keyboard on one screen, the way the genre has always been played.
 */
export function createAshenRing(): GameRuntime {
  return {
    id: GAME_IDS.ashenRing,

    async launch(context: GameContext): Promise<Result<GameHandle>> {
      const session = new AshenRingSession(context);
      session.begin();
      return ok(session);
    },
  };
}
