// Service worker: always load the newest version of the game.
// GitHub Pages lets browsers reuse files for up to 10 minutes, so right after an update a browser
// could still run the old code. This asks the server every time (a quick "has it changed?" check,
// so unchanged files aren't downloaded again) and only falls back to the saved copy when offline.
const CACHE = 'ragdoll-sandbox';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
      if (res.ok) caches.open(CACHE).then((c) => c.put(req.url, res.clone())).catch(() => {});
      return res;
    } catch (err) {
      const hit = await caches.match(req.url);
      if (hit) return hit;
      throw err;
    }
  })());
});
