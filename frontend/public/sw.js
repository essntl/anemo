/*
 * Anemo service worker. Deliberately minimal:
 *
 *  - /api/* is never touched: chats, files and settings always come live from
 *    your server and are never stored on the device.
 *  - Built JS/CSS (/assets/*, content-hashed file names) and icons are cached, so
 *    the app starts quickly.
 *  - Pages are fetched from the network; if the server can't be reached, a small
 *    offline page is shown instead of the browser's error.
 *
 * Bump VERSION to drop old caches after changing this file or the icons.
 * Icons keep their file names, so when they change also raise the `?v=` number
 * here, in index.html, offline.html and manifest.webmanifest: browsers hold on to
 * tab icons for a long time otherwise.
 */
const VERSION = 'v2'
const CACHE = `anemo-shell-${VERSION}`
const PRECACHE = ['/offline.html', '/favicon.svg?v=2', '/icons/icon-192.png?v=2']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return // always the network, never cached

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html')))
    return
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    // Hashed/static files never change under the same name: cache first.
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone()
              caches.open(CACHE).then((cache) => cache.put(request, copy))
            }
            return response
          }),
      ),
    )
  }
})
