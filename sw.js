const CACHE_NAME = 'putseller-v8';
const FILES = [
  './',
  './index.html',
  './app.css',
  './release-notes.html',
  './js/storage.js',
  './js/helpers.js',
  './js/ui.js',
  './js/api.js',
  './js/scoring.js',
  './js/settings.js',
  './js/watchlist.js',
  './js/dashboard.js',
  './js/ticker.js',
  './js/options.js',
  './js/earnings.js',
  './js/vix.js',
  './js/etf.js',
  './js/market.js',
  './js/prefetch.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
