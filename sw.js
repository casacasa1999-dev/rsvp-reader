const CACHE = 'rsvp-4.01'; // バージョン番号。index.html の表示と必ずそろえる
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-512.png'];
const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
const CDN = [PDFJS_BASE + 'legacy/build/pdf.min.mjs', PDFJS_BASE + 'legacy/build/pdf.worker.min.mjs'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(async cache => {
    // cache: 'reload' skips the browser's HTTP cache so a new version never stores stale files.
    await cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
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
    if (sameOrigin) {
      // App files: network first (revalidated against the server), cache only when offline.
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return (await cache.match(req, { ignoreSearch: true })) || Response.error();
      }
    }
    // CDN files are versioned: cache first.
    const cached = await cache.match(req);
    if (cached) return cached;
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  }));
});
