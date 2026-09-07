import type { LoggerPort } from '@app/ports/logger.port.ts';

/**
 * Registers the service worker, which is what makes the arcade installable.
 *
 * Only in a production build. In development the worker would sit in front of
 * Vite's module graph and answer with yesterday's modules, which presents as
 * edits that do not appear — a genuinely bewildering half hour.
 *
 * Registration is deliberately not awaited by anything: the app works exactly
 * the same without a worker, so a failure here is worth a log line and nothing
 * more.
 */
export function registerServiceWorker(logger: LoggerPort): void {
  const log = logger.scoped('pwa');

  if (!import.meta.env.PROD) {
    log.log('debug', 'development build — no service worker');
    return;
  }
  if (!('serviceWorker' in navigator)) {
    log.log('debug', 'this browser has no service worker support');
    return;
  }

  const register = (): void => {
    // Scoped to the deployed base rather than the origin root, so the arcade
    // still works under a project subpath.
    const url = new URL('sw.js', document.baseURI);
    navigator.serviceWorker.register(url.href, { scope: new URL('.', document.baseURI).pathname }).then(
      (registration) => {
        log.log('info', 'service worker registered', { scope: registration.scope });
      },
      (error: unknown) => {
        // Common and harmless: a browser with storage blocked, or a private
        // window. The app is unaffected — it simply is not installable.
        log.log('warn', 'could not register the service worker', error);
      },
    );
  };

  /*
   * Waiting for `load` keeps registration off the critical path — but only if
   * `load` has not already happened.
   *
   * It usually has. The composition root is `async`: it awaits Firebase before
   * it gets here, and the page finishes loading during that await. Listening
   * unconditionally meant the callback was attached to an event that had
   * already fired, so the worker was never registered and the app was never
   * installable — which looks exactly like a browser that does not support it.
   */
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
