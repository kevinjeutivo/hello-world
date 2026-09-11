// ============================================
// Income Engine — Service Worker
// Caches the entire app shell on first visit
// so the app loads offline with no internet.
// Version bump this string to force a refresh
// of the cache when you deploy a new version.
// ============================================
const CACHE_NAME = 'income-engine-v448';
const APP_BUILD = 448; // increment with every deploy, matches CACHE_NAME version

// Third-party vendor assets (Chart.js, Google Fonts) live in their OWN,
// separately-versioned cache, deliberately not tied to CACHE_NAME/APP_BUILD
// -- so a routine app deploy doesn't re-download files that didn't change.
// Chart.js's URL is version-pinned (cdnjs' own convention makes a versioned
// path immutable) -- an actual Chart.js upgrade means changing the URL
// itself, which naturally cache-misses and re-fetches on its own, no
// version bump needed here for that case. Google Fonts' URL has no such
// version pin, so its response COULD legitimately change at the same URL
// over time -- VENDOR_CACHE_VERSION is the deliberate, manual lever for
// that case specifically: bump it if something ever looks stale and needs
// a forced re-fetch, independent of the app's own deploy cadence.
const VENDOR_CACHE_VERSION = 1;
const VENDOR_CACHE_NAME = 'income-engine-vendor-v' + VENDOR_CACHE_VERSION;
const VENDOR_SHELL = [
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@400;600;700;800&display=swap'
];

// Files to cache on install — the app shell
const APP_SHELL = [
  './',
  './index.html',
  './app.css',
  './js/api.js',
  './js/dashboard.js',
  './js/wheelbacktest.js',
  './js/earnings.js',
  './js/etf.js',
  './js/helpers.js',
  './js/market.js',
  './js/options.js',
  './js/prefetch.js',
  './js/scoring.js',
  './js/settings.js',
  './js/storage.js',
  './js/ticker.js',
  './js/ui.js',
  './js/vix.js',
  './js/watchlist.js',
  './js/income.js',
  './sw.js'
];

// Install: cache the app shell (always fresh, {cache:'reload'}) and the
// vendor assets (only fetched if not already present -- see VENDOR_CACHE
// comment above for why re-fetching those on every install would defeat
// the point).
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then(cache => {
        // cache.addAll() previously used here relies on the browser's default
        // HTTP cache mode for its internal fetches -- meaning even a brand
        // new CACHE_NAME could silently get populated with STALE file bytes,
        // if GitHub Pages' own Cache-Control headers (or the browser's disk
        // cache) still consider a file "fresh" from an earlier visit. A
        // version bump reliably changes the cache *name*; it does not, on
        // its own, force a genuine network fetch of the files underneath it.
        // {cache:'reload'} on each fetch forces a real network round-trip,
        // bypassing that layer, so a version bump reliably gets truly fresh
        // files every time. As a side benefit, per-file .catch() also means
        // one bad file fetch no longer aborts caching of every other shell
        // file the way a single combined addAll() catch did.
        return Promise.all(APP_SHELL.map(url =>
          fetch(new Request(url, {cache: 'reload'}))
            .then(response => cache.put(url, response))
            .catch(err => console.warn('SW: failed to cache', url, err))
        ));
      }),
      caches.open(VENDOR_CACHE_NAME).then(cache => {
        return Promise.all(VENDOR_SHELL.map(url =>
          cache.match(url).then(existing => {
            if (existing) return; // already cached, deliberately not re-fetched
            return fetch(url)
              .then(response => cache.put(url, response))
              .catch(err => console.warn('SW: failed to cache vendor asset', url, err));
          })
        ));
      })
    ]).then(() => self.skipWaiting())
  );
});

// Activate: delete old caches -- but preserve the current vendor cache,
// which is deliberately versioned independently of CACHE_NAME and should
// survive across app deploys, not get swept alongside them the same way
// the old, version-tied app-shell caches correctly do.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== VENDOR_CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - App shell files (index.html, JS): cache-first, from CACHE_NAME
// - Vendor assets (Chart.js, fonts): cache-first, from VENDOR_CACHE_NAME
// - API calls (finnhub, yahoo, cboe): network-first, no caching
//   (financial data caching is handled by the app via localStorage)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept API calls -- let them go to network directly
  const apiHosts = ['finnhub.io', 'query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'cdn.cboe.com'];
  // Cloudflare Worker proxy -- matched by pattern (*.workers.dev) rather
  // than a fixed hostname, since the worker address is now a user-entered
  // fragment (see WORKER_URL in index.html), not something this file can
  // hardcode. Missing this was a real bug: without it, the worker's own
  // responses fell through to the cache-first app-shell strategy below,
  // meaning a stale successful response could get served from cache
  // instead of ever reaching the network on a repeat request to the same
  // URL -- e.g. making a broken/rotated PROXY_SECRET appear to still work.
  const isWorkerHost = url.hostname.endsWith('.workers.dev');
  if (apiHosts.some(h => url.hostname.includes(h)) || isWorkerHost) {
    return; // pass through to network
  }

  // caches.match() with no cache name searches across ALL caches for this
  // origin, so this works unchanged whether a match happens to live in
  // CACHE_NAME or VENDOR_CACHE_NAME -- no need to check which.
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET responses for app shell resources
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          // Route vendor URLs into VENDOR_CACHE_NAME specifically, not
          // CACHE_NAME, in the edge case this fallback ever fires for one
          // (e.g. install's vendor pre-cache failed for that one file) --
          // keeps it persisting across future deploys either way, rather
          // than landing in the version-tied cache and getting swept on
          // the next one.
          const isVendorUrl = VENDOR_SHELL.includes(event.request.url);
          caches.open(isVendorUrl ? VENDOR_CACHE_NAME : CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // If offline and not cached, return a minimal offline message
        // only for navigation requests (not assets)
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
