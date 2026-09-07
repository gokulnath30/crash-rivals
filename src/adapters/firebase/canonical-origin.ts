/**
 * Keeping the app and its sign-in on one origin.
 *
 * Firebase Auth hands a credential back through storage belonging to the
 * `authDomain`. Safari, iOS and Chrome-with-third-party-cookies-off partition
 * that storage per origin, so when the app is served from a *different* origin
 * to its authDomain the credential never arrives: Google accepts the login,
 * the visitor is returned, and the app still believes nobody is signed in.
 *
 * A Firebase project is handed two hosting domains that serve the same site —
 * `project.web.app` and `project.firebaseapp.com` — and the authDomain is one
 * of them. Opening the app on the other one is therefore the broken case, and
 * moving to the authDomain fixes it outright.
 *
 * The alternative fix is to keep whichever domain you prefer and register its
 * `/__/auth/handler` as an authorised redirect URI on the project's OAuth
 * client, in the Google Cloud console. That is a better end state and it
 * cannot be done from here — Google rejects a redirect URI it has not been
 * told about, with `redirect_uri_mismatch`, which breaks sign-in on every
 * platform rather than only Apple ones. So this moves the app to the domain
 * that already works.
 */

export interface OriginFacts {
  /** The configured `authDomain`, which carries no scheme. */
  readonly authDomain: string;
  /** `location.host` — hostname and port. */
  readonly host: string;
  /** Path, query and hash, so an invite link survives the move. */
  readonly rest: string;
  /** Whether this load is already the result of one of these redirects. */
  readonly alreadyMoved: boolean;
}

/** Firebase's two automatic hosting domains for a project. */
const HOSTING_SUFFIXES = ['.web.app', '.firebaseapp.com'];

/**
 * Where the app should be, or null to stay put.
 *
 * Deliberately narrow. It only ever moves between the two hosting domains of
 * one project, which are known to serve the same site — never off a custom
 * domain, whose owner chose it and where the right fix is the console one, and
 * never to a domain that might not have this app on it.
 */
export function canonicalUrl(facts: OriginFacts): string | null {
  // One attempt, ever. If the destination somehow bounces back, a loop would
  // be a page that never loads rather than a page with a sign-in problem.
  if (facts.alreadyMoved) return null;

  const host = facts.host.toLowerCase();
  const authDomain = facts.authDomain.toLowerCase();
  if (!authDomain || host === authDomain) return null;

  // Both ends must be Firebase hosting domains for the *same* project, which
  // is what makes them interchangeable.
  const project = projectOf(host);
  if (!project || project !== projectOf(authDomain)) return null;

  return `https://${authDomain}${facts.rest}`;
}

/**
 * Whether this session has already been moved once.
 *
 * Storage being unavailable reads as "already moved", which is the safe way
 * round: it declines to redirect rather than risk a loop it has no way to
 * detect.
 */
function hasMoved(marker: string): boolean {
  try {
    return sessionStorage.getItem(marker) === '1';
  } catch {
    return true;
  }
}

/** The project label of a Firebase hosting domain, or null if it is not one. */
function projectOf(host: string): string | null {
  for (const suffix of HOSTING_SUFFIXES) {
    if (!host.endsWith(suffix)) continue;
    const label = host.slice(0, -suffix.length);
    // A single label only: `project.web.app`, not `something.project.web.app`,
    // which would be a preview channel and may not carry the same build.
    if (label.length > 0 && !label.includes('.')) return label;
  }
  return null;
}

/**
 * Moves the browser to the canonical origin if it is not already there.
 *
 * Returns true when a navigation has been started, which means the caller
 * should stop: the page is going away and booting the app would be wasted
 * work — and, worse, would flash a signed-out shell first.
 */
export function ensureCanonicalOrigin(authDomain: string): boolean {
  if (typeof window === 'undefined') return false;

  const marker = 'arcade.movedToAuthOrigin';
  const alreadyMoved = hasMoved(marker);

  const target = canonicalUrl({
    authDomain,
    host: window.location.host,
    rest: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    alreadyMoved,
  });
  if (!target) return false;

  try {
    sessionStorage.setItem(marker, '1');
  } catch {
    /* nothing to do; the guard above already declined in this case */
  }
  // `replace`, so Back does not bounce the visitor between the two domains.
  window.location.replace(target);
  return true;
}
