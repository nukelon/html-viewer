const CACHE_NAME = 'html-viewer-vfs';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.includes('/__vfs__/')) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const hit = await cache.match(event.request.url);
      if (hit) return hit;
      return new Response('Not Found', { status: 404 });
    })
  );
});
