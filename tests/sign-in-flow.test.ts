import { describe, expect, it } from 'vitest';
import { prefersRedirect, type BrowserFacts } from '@adapters/firebase/sign-in-flow.ts';

/**
 * Which sign-in flow each browser gets.
 *
 * This is the fix for "signing in with Google does nothing on an iPhone", and
 * it is exactly the kind of thing that cannot be caught by using the app: it
 * works on every desktop browser, and the platforms it fails on are the ones
 * hardest to get a console out of. So the rule is a pure function and these
 * are real user-agent strings.
 */

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1';
// iPadOS 13 and later. Note it says Macintosh, with no hint of an iPad.
const IPAD_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const MAC_SAFARI = IPAD_SAFARI;
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const facts = (over: Partial<BrowserFacts> = {}): BrowserFacts => ({
  userAgent: WINDOWS_CHROME,
  standalone: false,
  maxTouchPoints: 0,
  ...over,
});

describe('choosing a sign-in flow', () => {
  it('redirects on an iPhone, in Safari and in Chrome alike', () => {
    // Every browser on iOS is WebKit underneath, so the choice cannot be made
    // from the browser's name.
    expect(prefersRedirect(facts({ userAgent: IPHONE_SAFARI, maxTouchPoints: 5 }))).toBe(true);
    expect(prefersRedirect(facts({ userAgent: IPHONE_CHROME, maxTouchPoints: 5 }))).toBe(true);
  });

  it('redirects on an iPad, which claims to be a Mac', () => {
    // The user agent is indistinguishable from desktop Safari; the touch
    // screen is the only tell.
    expect(prefersRedirect(facts({ userAgent: IPAD_SAFARI, maxTouchPoints: 5 }))).toBe(true);
  });

  it('uses a popup on a real Mac, whose user agent looks the same', () => {
    // The other half of that: getting the iPad right must not cost every Mac
    // the nicer flow.
    expect(prefersRedirect(facts({ userAgent: MAC_SAFARI, maxTouchPoints: 0 }))).toBe(false);
    expect(prefersRedirect(facts({ userAgent: MAC_CHROME, maxTouchPoints: 0 }))).toBe(false);
  });

  it('uses a popup on desktop and on Android', () => {
    expect(prefersRedirect(facts({ userAgent: WINDOWS_CHROME }))).toBe(false);
    expect(prefersRedirect(facts({ userAgent: ANDROID_CHROME, maxTouchPoints: 5 }))).toBe(false);
  });

  it('redirects in an installed app, whatever the platform', () => {
    // A popup opened from a home-screen app lands in a separate browsing
    // context, so the credential it obtains can never reach the app. True on
    // Android too, not only iOS.
    expect(prefersRedirect(facts({ userAgent: WINDOWS_CHROME, standalone: true }))).toBe(true);
    expect(prefersRedirect(facts({ userAgent: ANDROID_CHROME, standalone: true, maxTouchPoints: 5 }))).toBe(
      true,
    );
  });

  it('is not fooled by a touch-screen Windows laptop', () => {
    // Touch points alone must not mean "Apple" — plenty of Windows machines
    // have a touch screen, and they are perfectly happy with a popup.
    expect(prefersRedirect(facts({ userAgent: WINDOWS_CHROME, maxTouchPoints: 10 }))).toBe(false);
  });
});
