/* Mindwhisper Acoustic service worker — cache-first app shell
 *
 * ROOM-V1 CORE is required. Call (tx2/rx2) assets are optional and cached
 * individually so a missing call file never blocks room TX/RX offline install.
 */
const CACHE_VERSION = 'mw-acoustic-v26-soft-bit-chase';

/** Room-v1 pages + modules — must succeed for install. */
const ROOM_SHELL = [
  './',
  './index.html',
  './tx.html',
  './rx.html',
  './credits.html',
  './css/app.css',
  './js/protocol.js',
  './js/crc16.js',
  './js/hamming.js',
  './js/ambient.js',
  './js/ambient-core.js',
  './js/ambient-nature.js',
  './js/ambient-profiles.js',
  './js/meditation-audio.js',
  './js/acoustic-config.js',
  './js/dsp-biquad.js',
  './js/tx-engine.js',
  './js/watermark.js',
  './js/tx.js',
  './js/rx.js',
  './js/rx-decoder.js',
  './js/protocol-v2.js',
  './js/rs-codec.js',
  './js/room-v2/room-v2-constants.js',
  './js/room-v2/room-v2-protocol.js',
  './js/room-v2/room-v2-rx.js',
  './audio/rx-worklet.js',
  './audio/rx-v2-worklet.js',
  './audio/ambient-worklet.js',
  './audio/meditation-loop-v1.mp3',
  './manifest.webmanifest',
  './icons/icon.svg',
];

/** Call channel — best-effort; other agents own these paths. */
const CALL_SHELL = [
  './tx2.html',
  './rx2.html',
  './js/call/call-constants.js',
  './js/call/call-carrier.js',
  './js/call/call-ambient.js',
  './js/call/call-tx.js',
  './js/call/call-rx.js',
  './js/call/call-sync.js',
  './js/call/call-combiner.js',
  './js/call/call-watermark.js',
  './js/call/call-v2-constants.js',
  './js/call/call-v2-protocol.js',
  './js/call/call-v2-dsp.js',
  './js/call/call-v2-tx.js',
  './js/call/call-v2-rx.js',
  './js/call/call-v2-reference.js',
  './audio/rx2-worklet.js',
  './audio/rx2-v2-worklet.js',
];

async function cacheAllOptional(cache, urls) {
  await Promise.all(
    urls.map((url) =>
      cache.add(url).catch(() => {
        /* missing call assets are OK */
      })
    )
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      await cache.addAll(ROOM_SHELL);
      await cacheAllOptional(cache, CALL_SHELL);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle same-origin requests under this SW scope (/acoustic/)
  if (url.origin !== self.location.origin) return;

  // Versioned meditation asset — cache-first (immutable filename).
  const isMeditationAsset = url.pathname.endsWith('/audio/meditation-loop-v1.mp3');
  if (isMeditationAsset) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return response;
        });
      })
    );
    return;
  }

  // Network-first for JS modules so room TX/RX pick up fixes without stale cache traps.
  const isModule =
    url.pathname.includes('/acoustic/js/') ||
    url.pathname.endsWith('/sw.js');

  if (isModule) {
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return response;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((response) => {
        const copy = response.clone();
        if (response.ok) {
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return response;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
