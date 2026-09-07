import { GAME_IDS } from '@adapters/catalog/static-catalog.adapter.ts';
import { ok, type Result } from '@domain/shared/result.ts';
import type { GameContext, GameHandle, GameRuntime } from '@app/ports/game-runtime.port.ts';
import type { PoseSourcePort } from '@app/ports/pose-source.port.ts';
import { TrainingSession } from './session.ts';

/**
 * The training space as the store sees it.
 *
 * A game in the catalogue's sense — something that mounts, runs and stops —
 * with no opponent, no score and no end. It takes its tracker rather than
 * building one, so the composition root decides whether that is a real camera
 * or a scripted stand-in.
 */
export function createTrainingSpace(deps: { pose: PoseSourcePort }): GameRuntime {
  return {
    id: GAME_IDS.trainingSpace,

    async launch(context: GameContext): Promise<Result<GameHandle>> {
      const session = new TrainingSession(context, deps.pose);
      session.begin();
      return ok(session);
    },
  };
}
