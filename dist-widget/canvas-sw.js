// BuzzAssist canvas asset cache. Over the tunnel this makes repeat visits
// paint images instantly and survives HTTP-cache eviction: asset previews are
// served cache-first from a persistent Cache Storage bucket, and the page can
// ask the worker to prefetch every image so offscreen ones are ready too.
const CACHE_NAME = 'buzzassist-canvas-assets-v1';
const ASSET_PREFIX = '/excalidraw-assets/';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

function isCacheableAssetRequest(request) {
  if (request.method !== 'GET') return false;
  // Video range requests must stream from the network (partial responses are
  // not safe to cache-first).
  if (request.headers.has('range')) return false;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  return url.origin === self.location.origin && url.pathname.startsWith(ASSET_PREFIX);
}

self.addEventListener('fetch', (event) => {
  if (!isCacheableAssetRequest(event.request)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response && response.ok) {
      cache.put(event.request, response.clone()).catch(() => {});
    }
    return response;
  })());
});

// The page posts { type: 'prefetch', urls: [...] } so the worker warms the
// cache for images the user has not scrolled to yet.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'prefetch' || !Array.isArray(data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const rawUrl of data.urls) {
      if (typeof rawUrl !== 'string' || !rawUrl) continue;
      try {
        if (await cache.match(rawUrl)) continue;
        const response = await fetch(rawUrl, { credentials: 'same-origin' });
        if (response && response.ok) await cache.put(rawUrl, response.clone());
      } catch {
        // Skip unreachable assets; the fetch handler will cache them on demand.
      }
    }
  })());
});
