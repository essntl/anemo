/*
 * Anemo service worker. Deliberately minimal:
 *
 *  - /api/* is never touched: chats, files and settings always come live from
 *    your server and are never stored on the device.
 *  - Built JS/CSS (/assets/*, content-hashed file names) and icons are cached, so
 *    the app starts quickly.
 *  - Pages are fetched from the network; if the server can't be reached, a small
 *    offline page is shown instead of the browser's error.
 *  - Push notifications (Settings > Notifications > Push): shows them while the app
 *    is closed, opens what they are about when tapped, and sends the one-time
 *    "Allow once" / "Deny" buttons of an approval request to the server.
 *
 * Bump VERSION to drop old caches after changing this file or the icons.
 * Icons keep their file names, so when they change also raise the `?v=` number
 * here, in index.html, offline.html and manifest.webmanifest: browsers hold on to
 * tab icons for a long time otherwise.
 */
const VERSION = 'v3'
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

// -- push notifications ------------------------------------------------------------------

const ICON = '/icons/icon-192.png?v=2'

/** Only pages of this app: a link in a push message never leads elsewhere. */
function safeLink(link) {
  return typeof link === 'string' && link.startsWith('/') && !link.startsWith('//') ? link : '/notifications'
}

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const buttons = Array.isArray(data.actions) ? data.actions.filter((a) => a && a.action && a.token) : []
  const tokens = {}
  for (const b of buttons) tokens[b.action] = b.token
  // Every push must show a notification (browsers require it), also when a tab is open.
  event.waitUntil(
    self.registration.showNotification(data.title || 'Anemo', {
      body: data.body || '',
      tag: data.tag || undefined,
      icon: ICON,
      data: { link: safeLink(data.link), tokens },
      actions: buttons.map((b) => ({ action: b.action, title: b.title })),
      requireInteraction: buttons.length > 0, // an approval waits for an answer
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  const note = event.notification
  const { link = '/notifications', tokens = {} } = note.data || {}
  note.close()
  const token = event.action ? tokens[event.action] : undefined
  event.waitUntil(token ? answer(token, link) : openPage(link))
})

/** One of the approval buttons: the token is the only credential it needs. */
async function answer(token, link) {
  let ok = false
  let message = 'Anemo could not be reached. Open it to answer.'
  try {
    const response = await fetch('/api/public/push/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'omit',
    })
    const body = await response.json().catch(() => null)
    if (response.ok && body) {
      ok = body.ok === true
      message = body.message || message
    } else if (body && body.error && body.error.message) {
      message = body.error.message
    }
  } catch {
    // offline: keep the message above
  }
  await self.registration.showNotification(ok ? 'Answered' : 'Not answered', {
    body: message,
    tag: 'anemo-push-answer',
    icon: ICON,
    data: { link: safeLink(link), tokens: {} },
  })
}

/** Show `link` in an open tab of the app (without reloading it), or open one. */
async function openPage(link) {
  const path = safeLink(link)
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const own = windows.find((c) => new URL(c.url).origin === self.location.origin)
  if (own) {
    own.postMessage({ type: 'anemo.navigate', path })
    if ('focus' in own) await own.focus()
    return
  }
  await self.clients.openWindow(path)
}
