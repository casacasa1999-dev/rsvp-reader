const CACHE = 'rsvp-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-512.png'];
const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
const CDN = [PDFJS_BASE + 'legacy/build/pdf.min.mjs', PDFJS_BASE + 'legacy/build/pdf.worker.min.mjs'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(async cache => {
    await cache.addAll(SHELL);
    // Best effort: PDF support also works offline once these are cached.
    await Promise.all(CDN.map(u => cache.add(u).catch(() => {})));
    self.skipWaiting();
  }));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const sameOrigin = new URL(req.url).origin === location.origin;
  if (!sameOrigin && !req.url.startsWith(PDFJS_BASE)) return;
  ev.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req, { ignoreSearch: sameOrigin });
    const fresh = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    // CDN files are versioned: cache-first. App files: serve cache, refresh in background.
    if (cached) { if (sameOrigin) fresh.catch(() => {}); return cached; }
    return fresh;
  }));
});
