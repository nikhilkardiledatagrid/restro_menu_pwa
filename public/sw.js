/* illy menu service worker — full offline cache for the kiosk page.
 *
 * SCOPE-AWARE VERSION (works at root domain OR sub-folder OR custom domain).
 *
 * Caches:
 *   - SHELL: the kiosk page itself + root navigation
 *   - IMG:   menu-images/* (product photos) under the scope
 *   - FONT:  fonts.googleapis.com stylesheet + fonts.gstatic.com font files
 *
 * Strategy:
 *   - Navigations / shell HTML  -> NetworkFirst, fallback to cached HTML
 *   - menu-images/*             -> CacheFirst + background revalidate
 *   - Google Fonts              -> StaleWhileRevalidate
 *   - Page can post {type:'PRECACHE', urls:[...]} to warm the image cache
 *
 * Goal: after one online load, the kiosk works fully offline indefinitely.
 *
 * IMPORTANT: bump VERSION on every menu/image/content change so kiosks pick
 * up the new assets — otherwise they keep serving the old cached version.
 *
 * Path handling: all path checks use self.registration.scope so this file
 * works unchanged whether the site is served at https://example.com/ or at
 * https://user.github.io/project/. See SCOPE constant below.
 */
const VERSION = 'v11';
const SHELL_CACHE = 'illy-shell-' + VERSION;
const IMG_CACHE = 'illy-menu-images-' + VERSION;
const FONT_CACHE = 'illy-fonts-' + VERSION;

// SCOPE resolves to the full URL of the directory this SW controls.
// Examples:
//   - Lovable:      https://stagingillymenu.lovable.app/
//   - GitHub Pages: https://amridhan.github.io/stagingillymenu/
//   - Custom:       https://menu.example.com/
// All shell/image URL checks below use this as the base.
const SCOPE = self.registration.scope;
const SHELL_URL = SCOPE;                       // navigations land on the directory root
const IMG_PREFIX = SCOPE + 'menu-images/';     // every product photo lives under this

const SHELL_URLS = [
  SHELL_URL,
  'https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600;700;800&display=swap',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Use no-cors for cross-origin Google Fonts so we still get an opaque
    // response into the cache when the strict CORS preflight isn't set.
    // Track whether the critical shell (the HTML page itself) actually made
    // it into the cache. If it didn't (e.g. offline install on first boot),
    // do NOT call skipWaiting — let the previous SW (if any) keep serving.
    // Activating an empty SW makes the next navigation render the 503
    // "Offline and no cached menu available." fallback, which is the most
    // common white-screen path on kiosks.
    let shellCached = false;
    await Promise.all(SHELL_URLS.map(async (url) => {
      try {
        const req = new Request(url, { cache: 'reload' });
        const resp = await fetch(req);
        if (resp && (resp.ok || resp.type === 'opaque')) {
          await cache.put(req, resp.clone());
          if (url === SHELL_URL) shellCached = true;
        }
      } catch (e) { /* offline at install — will retry on next online fetch */ }
    }));
    // First-ever install (no prior SW) is an exception: there's nothing to
    // fall back to, so activate anyway. With an existing controller we now
    // WAIT for the page to post {type:'SKIP_WAITING'} during an idle window
    // (no taps, no open lightbox). This prevents the mid-session blank that
    // happens when a new SW activates mid-tap. See message handler below.
    if (!self.registration.active) {
      self.skipWaiting();
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const keep = new Set([SHELL_CACHE, IMG_CACHE, FONT_CACHE]);
    await Promise.all(
      keys.filter((k) => /^illy-(shell|menu-images|fonts)-/.test(k) && !keep.has(k))
          .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

function isSameOrigin(url) {
  try { return new URL(url).origin === self.location.origin; }
  catch (e) { return false; }
}
function isMenuImage(url) {
  // True iff the request URL is inside the scope's menu-images/ folder.
  // Using full-URL prefix match (instead of pathname.startsWith) so this
  // works correctly when the site is in a sub-folder.
  try {
    const href = new URL(url).href;
    return href.indexOf(IMG_PREFIX) === 0;
  } catch (e) { return false; }
}
function isGoogleFont(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com';
  } catch (e) { return false; }
}
function isCacheableImage(resp) {
  if (!resp || !resp.ok || resp.status !== 200) return false;
  const ct = resp.headers.get('content-type') || '';
  return ct.indexOf('image/') === 0;
}
function isShellRequest(req) {
  // Any navigation (the user typing a URL or clicking a link to this page)
  // counts as a shell request.
  if (req.mode === 'navigate') return true;
  if (!isSameOrigin(req.url)) return false;
  // Also catch direct GETs to the shell URL itself, the renamed index.html,
  // or a /standalone or /standalone.html variant that some hosts produce.
  const href = new URL(req.url).href;
  return (
    href === SHELL_URL ||
    href === SHELL_URL + 'index.html' ||
    href === SHELL_URL + 'standalone.html' ||
    href === SHELL_URL + 'standalone'
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // 1. App shell / navigations -> NetworkFirst, cache fallback.
  if (isShellRequest(req)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const fresh = await fetch(req, { cache: 'no-cache' });
        if (fresh && fresh.ok) {
          // Always store under the canonical SHELL_URL so any future
          // shell-request variant (root, index.html, standalone.html)
          // can be served from the same cached entry.
          cache.put(SHELL_URL, fresh.clone());
          return fresh;
        }
        throw new Error('non-ok shell response');
      } catch (e) {
        const cached = await cache.match(SHELL_URL)
                    || await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        return new Response('Offline and no cached menu available.', {
          status: 503, headers: { 'Content-Type': 'text/plain' },
        });
      }
    })());
    return;
  }

  // 2. Menu images -> CacheFirst + background revalidate.
  if (isMenuImage(req.url)) {
    event.respondWith((async () => {
      const cache = await caches.open(IMG_CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) {
        event.waitUntil((async () => {
          try {
            const fresh = await fetch(req, { cache: 'no-cache' });
            if (isCacheableImage(fresh)) cache.put(req, fresh.clone());
          } catch (e) { /* offline ok */ }
        })());
        return cached;
      }
      try {
        const fresh = await fetch(req, { cache: 'reload' });
        if (isCacheableImage(fresh)) cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // 3. Google Fonts -> StaleWhileRevalidate.
  if (isGoogleFont(req.url)) {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then((resp) => {
        if (resp && (resp.ok || resp.type === 'opaque')) cache.put(req, resp.clone());
        return resp;
      }).catch(() => null);
      return cached || (await network) || new Response('', { status: 504 });
    })());
    return;
  }

  // 4. Other same-origin GETs (JS, CSS, favicons): NetworkFirst with cache fallback,
  //    stored in SHELL_CACHE so the page boots offline.
  if (isSameOrigin(req.url)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // Everything else (including POST /api/public/track) passes through untouched.
});

// Page-driven precache: standalone.html posts the full list of menu image URLs
// once registered, so every product photo lands in cache during the first
// online session — not lazily as the user scrolls.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type !== 'PRECACHE' || !Array.isArray(data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(IMG_CACHE);
    // Modest concurrency so we don't thrash the kiosk's network.
    const queue = data.urls.slice();
    const workers = Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const url = queue.shift();
        try {
          const match = await cache.match(url, { ignoreSearch: true });
          if (match) continue;
          const resp = await fetch(url, { cache: 'reload' });
          if (isCacheableImage(resp)) await cache.put(url, resp.clone());
        } catch (e) { /* skip */ }
      }
    });
    await Promise.all(workers);
  })());
});
