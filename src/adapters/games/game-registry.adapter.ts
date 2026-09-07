import { GAME_IDS } from '@adapters/catalog/static-catalog.adapter.ts';
import type { GameId } from '@domain/shared/ids.ts';
import { fail, failure, ok, type Result } from '@domain/shared/result.ts';
import type { GameRegistryPort, GameRuntime } from '@app/ports/game-runtime.port.ts';
import type { LoggerPort } from '@app/ports/logger.port.ts';

/**
 * Turns a catalogue entry into something playable.
 *
 * Each game is behind a dynamic `import`, which is the whole point: the store
 * shell is small and paints immediately, and a player who only wants the
 * racing game never downloads the fighting rules or the fighter renderer.
 * Vite splits each of these into its own chunk automatically because the
 * import is a literal it can see.
 *
 * This is also where a game's adapters get built, so the games themselves
 * never construct one — they take what they need as a parameter.
 */
export class GameRegistry implements GameRegistryPort {
  constructor(private readonly logger: LoggerPort) {}

  async load(id: GameId): Promise<Result<GameRuntime>> {
    try {
      switch (id) {
        case GAME_IDS.crashRivals: {
          const { createCrashRivals } = await import('@games/crash-rivals/index.ts');
          return ok(createCrashRivals());
        }

        case GAME_IDS.ashenRing: {
          const { createAshenRing } = await import('@games/ashen-ring/index.ts');
          return ok(createAshenRing());
        }

        case GAME_IDS.trainingSpace: {
          const { createTrainingSpace } = await import('@games/training-space/index.ts');
          const { MediaPipeHolisticSource } = await import(
            '@adapters/pose/mediapipe-holistic.adapter.ts'
          );
          return ok(createTrainingSpace({ pose: new MediaPipeHolisticSource(this.logger) }));
        }

        default:
          return fail(failure('game-not-found', 'That game is not on the shelf.'));
      }
    } catch (error: unknown) {
      // A chunk that fails to load is usually a stale deploy or a dropped
      // connection, and both are worth telling the player about plainly.
      this.logger.log('error', `could not load the game ${id}`, error);
      return fail(
        failure('unavailable', 'Could not load that game. Check the connection and try again.'),
      );
    }
  }
}
