// Workboard service worker: makes the app installable and opens instantly (and offline, read-only) on the phone.
// Strategy: network-first for everything we cache, so a deploy is picked up on the next load; cache is the fallback.
const CACHE = 'workboard-v32';
// The page itself writes the last server-confirmed board here (see writeSnapshot in app.js); survives app updates.
const SNAPSHOT = 'workboard-snapshot';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/api.js', '/js/actions.js', '/js/components.js', '/js/drawer.js', '/js/settings.js', '/js/store.js', '/js/util.js', '/js/views.js', '/js/timeline.js', '/js/motion.js', '/js/focus.js', '/js/schedule.js', '/js/shopping.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png', '/icons/favicon-64.png', '/fonts/heebo-hebrew-wght-normal.woff2', '/fonts/heebo-latin-wght-normal.woff2'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SNAPSHOT).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Live data is never served stale. Offline, the bootstrap falls back to the page-written confirmed snapshot.
  if (url.pathname === '/api/bootstrap') {
    event.respondWith(fetch(request).catch(async () => (await (await caches.open(SNAPSHOT)).match('/api/bootstrap')) || Response.error()));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) cache.put(url.pathname === '/' ? '/' : request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(url.pathname === '/' || request.mode === 'navigate' ? '/' : request);
      if (cached) return cached;
      throw new Error('offline');
    }
  })());
});
