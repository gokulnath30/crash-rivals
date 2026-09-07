/*
 * The service worker.
 *
 * Two jobs, in this order of importance:
 *
 *   1. Never serve stale code. A service worker that caches an app shell and
 *      then answers from it forever is the single most common way a PWA gets
 *      into a state its owner cannot fix — every visitor pinned to a build
 *      from weeks ago, with no way to tell them to clear it. So anything that
 *      can change at a fixed URL is fetched from the network first, and the
 *      cache is only the fallback.
 *
 *   2. Be installable and survive a bad connection. Chrome will only offer to
 *      install an app whose worker handles `fetch`, and the hashed bundles are
 *      safe to keep forever because their names change when their contents do.
 *
 * Deliberately hand-written rather than generated. The caching rules here are
 * a handful of decisions about *this* app — which URLs are immutable, which
 * must never be touched — and they are easier to get right, and to read back,
 * as fifty lines than as a generated manifest.
 */

/** Content-addressed: the name changes when the bytes do, so keep these. */
const IMMUTABLE = 'arcade-immutable';
/** Anything that can change under a fixed URL. Only ever a fallback. */
const PAGES = 'arcade-pages-v1';

const KEEP = [IMMUTABLE, PAGES];

/**
 * A ceiling on the immutable cache.
 *
 * Hashed filenames mean a deploy adds entries rather than replacing them, so
 * without a bound this grows by the size of the bundle on every release.
 * `cache.keys()` comes back in insertion order, which makes "drop the oldest"
 * a two-line prune.
 */
const MAX_IMMUTABLE_ENTRIES = 80;

self.addEventListener('install', () => {
  // Nothing is precached. Precaching an app shell means guessing which URLs
  // matter and going stale when that guess changes; the first real visit
  // populates the caches with exactly what this build asked for.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => !KEEP.includes(name)).map((name) => caches.delete(name)));
      // Take over open tabs, so a reload is not needed for the new worker to
      // start answering.
      await self.clients.claim();
    })(),
  );
});

/** URLs this worker must keep its hands off entirely. */
function isOffLimits(url, request) {
  // Somewhere else entirely: fonts, Google's own sign-in pages, Firestore.
  // Caching any of that ranges from useless to a security problem.
  if (url.origin !== self.location.origin) return true;

  /*
   * Firebase's reserved paths, which Hosting serves on every site in the
   * project: `/__/auth/handler`, `/__/auth/iframe`, `/__/firebase/init.json`.
   *
   * These are same-origin — deliberately, because that is what makes Google
   * sign-in work in Safari — and they must never be cached. They are the
   * moving parts of an OAuth exchange: a cached handler would answer a fresh
   * sign-in with a stale one's state, and the failure would look like
   * "signing in does nothing".
   */
  if (url.pathname.startsWith('/__/')) return true;
  // Only plain GETs. Anything else is a write.
  if (request.method !== 'GET') return true;
  // Range requests are for media seeking; a cached 200 cannot answer one.
  if (request.headers.has('range')) return true;
  return false;
}

/**
 * Vite's hashed output, and only that.
 *
 * Icons and the manifest live at fixed URLs, so however rarely they change,
 * caching them forever would mean never seeing the new one. They are small
 * and the hosting headers already cache them; they go through the same
 * network-first path as everything else.
 */
function isImmutable(url) {
  return url.pathname.includes('/assets/');
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (isOffLimits(url, event.request)) return;

  if (isImmutable(url)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Everything else — the page itself, the framed game, the manifest, the
  // character models — can change at a fixed URL, so the network decides and
  // the cache is the safety net.
  event.respondWith(networkFirst(event.request));
});

async function cacheFirst(request) {
  const cache = await caches.open(IMMUTABLE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    void prune(cache);
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(PAGES);
  try {
    const response = await fetch(request);
    // Opaque and error responses are not worth keeping; a cached 404 outlives
    // the mistake that caused it.
    if (response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;
    // A navigation with nothing cached: fall back to the app's entry point,
    // which is what a single-page app wants for any route.
    if (request.mode === 'navigate') {
      const shell = await cache.match('/');
      if (shell) return shell;
    }
    throw error;
  }
}

async function prune(cache) {
  const keys = await cache.keys();
  const excess = keys.length - MAX_IMMUTABLE_ENTRIES;
  for (let index = 0; index < excess; index += 1) {
    const key = keys[index];
    if (key) await cache.delete(key);
  }
}
