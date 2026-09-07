/**
 * Popup or redirect.
 *
 * Firebase offers both and they are not interchangeable. A popup keeps the
 * player on the page, which is nicer, and it is what desktop browsers want. A
 * redirect navigates away and comes back, which is uglier and is the only
 * thing that works in two situations:
 *
 *   * **An installed app.** `window.open` from a home-screen app opens a
 *     separate browsing context — on iOS a web view with its own storage —
 *     so the credential the popup obtains has nowhere to go. The sign-in
 *     succeeds and the app never hears about it.
 *
 *   * **iPhone and iPad, in any browser.** Every browser on iOS is WebKit,
 *     and WebKit's storage partitioning makes the popup's hand-back
 *     unreliable even in a normal tab.
 *
 * Kept as a pure function of a few facts rather than reading `navigator`
 * directly, so the decision can be tested without a browser — and so the
 * reasoning is in one readable place rather than spread through a `catch`.
 */
export interface BrowserFacts {
  readonly userAgent: string;
  /** True when running as an installed app rather than in a browser tab. */
  readonly standalone: boolean;
  /**
   * `navigator.maxTouchPoints`. The one reliable way to spot an iPad, which
   * has claimed to be a Mac in its user agent since iPadOS 13.
   */
  readonly maxTouchPoints: number;
}

export function prefersRedirect(facts: BrowserFacts): boolean {
  // An installed app cannot use a popup at all, on any platform.
  if (facts.standalone) return true;
  return isApple(facts);
}

/** iPhone, iPod, or an iPad pretending to be a Mac. */
function isApple(facts: BrowserFacts): boolean {
  const ua = facts.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // iPadOS 13 and later send a desktop Safari user agent. A Mac with a touch
  // screen does not exist, so touch points are what separate them.
  return /Macintosh/i.test(ua) && facts.maxTouchPoints > 1;
}

/** Reads the facts off the real browser. */
export function browserFacts(): BrowserFacts {
  return {
    userAgent: navigator.userAgent,
    standalone: isStandalone(),
    maxTouchPoints: navigator.maxTouchPoints,
  };
}

/**
 * Whether this is an installed app.
 *
 * Two mechanisms because iOS supports neither of the others: the media query
 * is the standard, and `navigator.standalone` is Safari's own flag and the
 * only one that works there. Both display modes this app declares count —
 * `fullscreen` is its first choice, with `standalone` as the fallback.
 */
function isStandalone(): boolean {
  const ios = (navigator as Navigator & { standalone?: boolean }).standalone;
  if (ios === true) return true;
  if (typeof window.matchMedia !== 'function') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches
  );
}
