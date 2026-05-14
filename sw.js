// ============================================
// PutSeller Pro — Service Worker
// Caches the entire app shell on first visit
// so the app loads offline with no internet.
// Version bump this string to force a refresh
// of the cache when you deploy a new version.
// ============================================
const CACHE_NAME = 'putseller-v28';

// Files to cache on install — the app shell
const APP_SHELL = [
  './',
  './index.html',
  './app.css',
  './release-notes.html',
  './js/api.js',
  './js/dashboard.js',
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
      return cache.addAll(APP_SHELL).catch(err => {
        // Font/CDN failures should not block install
        console.warn('SW: some shell resources failed to cache', err);
      });
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
  if (apiHosts.some(h => url.hostname.includes(h))) {
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
