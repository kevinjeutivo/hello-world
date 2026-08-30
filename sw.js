// ============================================
// Income Engine — Service Worker
// Caches the entire app shell on first visit
// so the app loads offline with no internet.
// Version bump this string to force a refresh
// of the cache when you deploy a new version.
// ============================================
const CACHE_NAME = 'putseller-v409';
const APP_BUILD = 409; // increment with every deploy, matches CACHE_NAME version

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
  './sw.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@400;600;700;800&display=swap'
];

// Install: cache the app shell
self.addEventListener('install', event => {
  event.waitUntil(
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
      // one bad CDN fetch (Chart.js, fonts) no longer aborts caching of
      // every other shell file the way a single combined addAll() catch did.
      return Promise.all(APP_SHELL.map(url =>
        fetch(new Request(url, {cache: 'reload'}))
          .then(response => cache.put(url, response))
          .catch(err => console.warn('SW: failed to cache', url, err))
      ));
    }).then(() => self.skipWaiting())
  );
});

// Activate: delete old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - App shell files (index.html, Chart.js, fonts): cache-first
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

  // For everything else (app shell): cache-first with network fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET responses for app shell resources
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
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
