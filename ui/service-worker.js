const CACHE = 'orangebox-shell-v3';
const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/diff.js',
  '/dom.js',
  '/spend.js',
  '/tools.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-maskable.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Prompt data and live feeds must never enter browser-managed caches.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/openai') || url.pathname.startsWith('/anthropic') || url.pathname.startsWith('/r/')) return;

  const isNavigation = request.mode === 'navigate';
  const isShellAsset = SHELL.includes(url.pathname);
  if (!isNavigation && !isShellAsset) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && isShellAsset) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        if (isNavigation) return (await caches.match('/')) || Response.error();
        return (await caches.match(request)) || Response.error();
      })
  );
});
