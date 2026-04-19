// Gradicus Daily Report — service worker
//
// Strategy:
//   - Network-first for navigations / HTML  -> latest report when online,
//     cached HTML when offline.
//   - Cache-first for same-origin static    -> instant chrome / icons / manifest.
//   - Passthrough for cross-origin (Chart.js CDN) so we don't pollute the cache;
//     the report renders fine without the chart script when offline.
//
// Bump CACHE when the SW logic itself changes; the activate handler will
// then purge any stale caches.

const CACHE = 'gradicus-shell-v1';

const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/favicon.svg',
  '/icons/favicon-32.png',
  '/icons/favicon-16.png',
  '/icons/apple-touch-icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin requests (Chart.js CDN, etc.) — don't intercept.
  if (url.origin !== self.location.origin) return;

  const isHTML = req.mode === 'navigate'
    || (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // Network-first for HTML. Cache the latest under both '/' and '/index.html'
    // so a cold launch from either entry point can hit the cache.
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => {
            c.put('/index.html', clone.clone());
            c.put('/', clone);
          });
          return resp;
        })
        .catch(() => caches.match('/index.html').then((m) => m || caches.match('/')))
    );
    return;
  }

  // Cache-first for same-origin static assets.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((resp) => {
      // Only cache successful, basic responses.
      if (resp && resp.status === 200 && resp.type === 'basic') {
        const clone = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, clone));
      }
      return resp;
    }))
  );
});
