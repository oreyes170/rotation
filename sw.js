/* Offline support: serve the app from cache, refresh the cache in the background. */
const CACHE = 'rotation-v28'; // keep in step with VERSION in app.js
const VENDOR = 'rotation-vendor-1'; // big third-party files (the screenshot reader); kept across app versions
const SHELL = ['./', './index.html', './app.js', './styles.css', './manifest.webmanifest', './favicon-32.png', './apple-touch-icon.png', './icon-192.png', './icon-512.png'];
// cache: 'reload' skips the browser's HTTP cache, so a new version never installs old files
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== VENDOR).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/vendor/')) {   // fetched once, on first use, then served from the vendor cache
    e.respondWith(caches.open(VENDOR).then(async c => (await c.match(e.request)) || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || c.match('./index.html');
  }));
});
