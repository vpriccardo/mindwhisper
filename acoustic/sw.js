/* Mindwhisper Acoustic service worker — cache-first app shell */
const CACHE_VERSION = 'mw-acoustic-v4-call';
const APP_SHELL = [
  './',
  './index.html',
  './tx.html',
  './rx.html',
  './tx2.html',
  './rx2.html',
  './css/app.css',
  './js/protocol.js',
  './js/crc16.js',
  './js/hamming.js',
  './js/ambient.js',
  './js/ambient-profiles.js',
  './js/dsp-biquad.js',
  './js/tx-engine.js',
  './js/watermark.js',
  './js/tx.js',
  './js/rx.js',
  './js/rx-decoder.js',
  './js/call/call-constants.js',
  './js/call/call-carrier.js',
  './js/call/call-ambient.js',
  './js/call/call-tx.js',
  './js/call/call-rx.js',
  './js/call/call-sync.js',
  './js/call/call-combiner.js',
  './js/call/call-watermark.js',
  './audio/rx-worklet.js',
  './audio/rx2-worklet.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './tests/protocol-tests.html',
  './tests/dsp-tests.html',
  './tests/simulation-tests.html',
  './tests/call-channel-tests.html',
  './docs/real-call-test-sheet.md',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
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
