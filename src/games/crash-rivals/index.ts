import { GAME_IDS } from '@adapters/catalog/static-catalog.adapter.ts';
import { capacityOf, HOST_SEAT, type SeatIndex } from '@domain/lobby/match.ts';
import { ok, type Result } from '@domain/shared/result.ts';
import { broadcast, type GameContext, type GameHandle, type GameRuntime } from '@app/ports/game-runtime.port.ts';
import type { Channel } from '@app/ports/peer-link.port.ts';
import { el } from '@ui/dom.ts';

/**
 * Crash Rivals, kept as the self-contained page it has always been — but
 * wired to the store's connection instead of its own.
 *
 * The game shipped before the store did, with its own PeerJS rooms pointed at
 * the free public broker. That broker is rate-limited and frequently
 * unavailable, which shows up as a "Connecting…" that never finishes. It also
 * meant the game had a second, parallel notion of rooms that the store's
 * invite links and guest list knew nothing about.
 *
 * So the page still runs in a frame, but on an online match the store hands it
 * connections that are already open: up to four browsers paired over WebRTC,
 * found through an invite link. Messages are relayed across the frame boundary
 * with `postMessage`.
 *
 * The room is a star with the host at the centre, so this bridge does the one
 * thing the framed game cannot: it stamps every incoming message with the seat
 * it came from. A guest's input is meaningless without knowing whose it is, and
 * the seat is knowable *only* out here, from which link delivered it — putting
 * it in the message body instead would let any guest claim any seat.
 */
export function createCrashRivals(): GameRuntime {
  return {
    id: GAME_IDS.crashRivals,

    async launch(context: GameContext): Promise<Result<GameHandle>> {
      const { online } = context;
      const log = context.logger.scoped('bridge');

      // Relative to the deployed base, so it works under a project subpath.
      const source = new URL('legacy/crash-rivals.html', document.baseURI);
      if (online) source.searchParams.set('embed', 'store');

      const frame = el('iframe', {
        className: 'legacy-frame',
        attrs: {
          src: source.href,
          title: 'Crash Rivals',
          allow: 'fullscreen; gamepad',
        },
      });

      const exit = el('div', { className: 'legacy-exit' }, [
        el('button', {
          className: 'btn btn--ghost',
          text: 'Back to the store',
          attrs: { type: 'button' },
        }),
      ]);
      exit.addEventListener('click', context.exit);

      const detach: (() => void)[] = [];

      if (online) {
        const origin = window.location.origin;

        // The host sends {t:'go'} the moment it starts, which can easily beat
        // the other frame's script into existence. Anything that arrives
        // before this frame says it is listening is held rather than shouted
        // into a void — otherwise the guest sits waiting for a race that has
        // already started.
        let frameReady = false;
        const queued: FrameMessage[] = [];

        const toFrame = (message: FrameMessage): void => {
          if (!frameReady) {
            if (queued.length < MAX_QUEUED_BEFORE_READY) queued.push(message);
            return;
          }
          frame.contentWindow?.postMessage(message, origin);
        };

        // Registered before the frame is added to the page, so the game's
        // "ready" cannot be posted before anyone is listening for it.
        const onMessage = (event: MessageEvent): void => {
          if (event.origin !== origin || event.source !== frame.contentWindow) return;
          const message = asFrameMessage(event.data);
          if (!message) return;

          if (message.type === 'arcade:ready') {
            frameReady = true;
            // Seat 0 hosts. Crash Rivals is host-authoritative in exactly the
            // same sense the store is: the host simulates, the guests send
            // inputs, so the seats map straight across.
            frame.contentWindow?.postMessage(
              {
                type: 'arcade:start',
                role: online.seat === HOST_SEAT ? 'host' : 'guest',
                seat: online.seat,
                capacity: capacityOf(online.match),
                // Who is a person. The host needs this to know which cars to
                // drive itself; every other seat in the room gets a machine.
                // A guest is told only its own seat, because the host is
                // authoritative and sends it the whole grid regardless.
                humanSeats: [HOST_SEAT, ...online.links.keys()].sort((a, b) => a - b),
              },
              origin,
            );
            // Then anything that arrived while it was still loading, in order.
            for (const held of queued.splice(0)) {
              frame.contentWindow?.postMessage(held, origin);
            }
            log.log('info', 'handed the framed game its connection', { seat: online.seat });
            return;
          }

          if (message.type === 'arcade:send') {
            // The host broadcasts; a guest has only one link, so for it this is
            // the same thing.
            broadcast(online, channelFor(message.payload), JSON.stringify(message.payload));
            return;
          }

          if (message.type === 'arcade:exit') {
            // The framed game's own "back to menu" — it has no menu to go back
            // to while the store is driving, so it hands control up instead.
            context.exit();
          }
        };

        window.addEventListener('message', onMessage);
        detach.push(() => {
          window.removeEventListener('message', onMessage);
        });

        for (const [seat, link] of online.links) {
          detach.push(
            link.onData((payload) => {
              if (typeof payload.data !== 'string') return;
              let parsed: unknown;
              try {
                parsed = JSON.parse(payload.data);
              } catch {
                // The far end is another browser; a malformed frame costs one
                // frame, not the race.
                return;
              }
              toFrame({ type: 'arcade:data', payload: parsed, from: seat });
            }),
          );

          detach.push(
            link.onStateChange((state) => {
              if (state !== 'closed' && state !== 'failed') return;
              // One guest dropping out of a four-car race is not the end of
              // the race — their car carries on under the machine. Only the
              // host going is fatal, because nothing else is simulating.
              if (seat === HOST_SEAT) toFrame({ type: 'arcade:bye' });
              else toFrame({ type: 'arcade:gone', seat });
            }),
          );
        }
      }

      context.mount.append(frame, exit);
      // The store's music would fight the game's own engine noise.
      context.audio.stopMusic(0.3);

      return ok({
        stop(): void {
          for (const remove of detach.splice(0)) remove();
          // Clearing src first stops the game's audio and render loop before
          // the element goes, rather than leaving it briefly running detached.
          frame.src = 'about:blank';
          frame.remove();
          exit.remove();
        },
      });
    },
  };
}

/**
 * Which channel a message belongs on.
 *
 * The game sends two kinds of traffic on one connection: `s` is the host's
 * world snapshot and `i` is the guest's input, both many times a second and
 * both worthless once superseded — they go on the unreliable channel, where a
 * dropped one is simply skipped. Everything else ('go', 'over') changes the
 * state of the race exactly once and must not be lost.
 */
export function channelFor(payload: unknown): Channel {
  if (payload && typeof payload === 'object') {
    const kind = (payload as { t?: unknown }).t;
    if (kind === 's' || kind === 'i') return 'fast';
  }
  return 'sure';
}

/** A ceiling on the pre-ready queue, so a frame that never loads cannot grow it without bound. */
const MAX_QUEUED_BEFORE_READY = 200;

type FrameMessage =
  | { readonly type: 'arcade:ready' }
  | {
      readonly type: 'arcade:start';
      readonly role: 'host' | 'guest';
      readonly seat: SeatIndex;
      readonly capacity: number;
      readonly humanSeats: readonly SeatIndex[];
    }
  | { readonly type: 'arcade:data'; readonly payload: unknown; readonly from: SeatIndex }
  | { readonly type: 'arcade:send'; readonly payload: unknown }
  | { readonly type: 'arcade:gone'; readonly seat: SeatIndex }
  | { readonly type: 'arcade:bye' }
  | { readonly type: 'arcade:exit' };

/** Nothing arriving across the frame boundary is taken on trust. */
function asFrameMessage(value: unknown): FrameMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  switch (message['type']) {
    case 'arcade:ready':
      return { type: 'arcade:ready' };
    case 'arcade:send':
      return { type: 'arcade:send', payload: message['payload'] };
    case 'arcade:bye':
      return { type: 'arcade:bye' };
    case 'arcade:exit':
      return { type: 'arcade:exit' };
    default:
      return null;
  }
}
