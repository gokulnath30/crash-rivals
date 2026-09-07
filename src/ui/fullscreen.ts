/**
 * Full screen, and the parts of it that are not one standard.
 *
 * The unprefixed API is what every current browser implements, but older
 * WebKit only has the `webkit` spelling and iPhone Safari has neither on
 * ordinary elements. So this reports whether it is available at all, which
 * lets the UI leave the button out rather than offer one that does nothing.
 *
 * Every call goes through its own object rather than being plucked into a
 * variable first — `const exit = document.exitFullscreen` then calling it
 * loses `this`, and these are methods that need theirs.
 */

interface WebkitDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

interface WebkitElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

const asWebkitDocument = (): WebkitDocument => document;
const rootElement = (): WebkitElement => document.documentElement;

/**
 * A refused request is not worth reporting.
 *
 * The browser refuses when the call did not come from a gesture, or when a
 * permissions policy forbids it — and in both cases the honest UI is a button
 * that visibly did nothing, not an error the player can do nothing about.
 */
const ignore = (): void => undefined;

/** Whether this browser can go fullscreen at all. */
export function canFullscreen(): boolean {
  if (typeof document === 'undefined') return false;
  const root = rootElement();
  return typeof root.requestFullscreen === 'function' || typeof root.webkitRequestFullscreen === 'function';
}

export function isFullscreen(): boolean {
  if (typeof document === 'undefined') return false;
  const owner = asWebkitDocument();
  return Boolean(owner.fullscreenElement ?? owner.webkitFullscreenElement);
}

/**
 * Goes fullscreen, or comes back.
 *
 * Always the document element, never a single game's canvas: a fullscreened
 * canvas loses the HUD drawn over it and, on a phone, the touch controls
 * beside it.
 */
export function toggleFullscreen(): void {
  const owner = asWebkitDocument();

  if (isFullscreen()) {
    if (typeof owner.exitFullscreen === 'function') {
      void owner.exitFullscreen().catch(ignore);
    } else if (typeof owner.webkitExitFullscreen === 'function') {
      void Promise.resolve(owner.webkitExitFullscreen()).catch(ignore);
    }
    return;
  }

  const root = rootElement();
  if (typeof root.requestFullscreen === 'function') {
    void root.requestFullscreen().catch(ignore);
  } else if (typeof root.webkitRequestFullscreen === 'function') {
    void Promise.resolve(root.webkitRequestFullscreen()).catch(ignore);
  }
}

/** Calls back whenever fullscreen is entered or left, however it happened. */
export function onFullscreenChange(listener: () => void): () => void {
  // Both spellings: a browser that fires the prefixed event does not fire the
  // plain one. And leaving with Escape has to update the button too, which is
  // the reason this is an event rather than something the click handler knows.
  const events = ['fullscreenchange', 'webkitfullscreenchange'];
  for (const event of events) document.addEventListener(event, listener);
  return () => {
    for (const event of events) document.removeEventListener(event, listener);
  };
}
