/**
 * The service worker's push handling (public/sw.js), run with a fake worker scope:
 * what a push shows, what a tap opens, and what the approval buttons send.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import source from '../../../public/sw.js?raw'

type FetchFn = (url: string, init: RequestInit) => Promise<Response>
type Listener = (event: Record<string, unknown>) => void

interface Shown {
  title: string
  options: { body: string; tag?: string; data: { link: string; tokens: Record<string, string> }; actions: { action: string; title: string }[]; requireInteraction?: boolean }
}

function load(fetchImpl: FetchFn) {
  const listeners: Record<string, Listener> = {}
  const shown: Shown[] = []
  const windows: { url: string; postMessage: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }[] = []
  const opened: string[] = []
  const self = {
    location: { origin: 'https://anemo.example' },
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    skipWaiting: () => undefined,
    registration: {
      showNotification: async (title: string, options: Shown['options']) => void shown.push({ title, options }),
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows,
      openWindow: async (url: string) => void opened.push(url),
    },
  }
  new Function('self', 'caches', 'fetch', source)(self, {}, fetchImpl)
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    let done: Promise<unknown> = Promise.resolve()
    listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => (done = p) })
    await done
  }
  return { dispatch, shown, windows, opened }
}

const push = (data: unknown) => ({ data: { json: () => data, text: () => JSON.stringify(data) } })

describe('push notifications in the service worker', () => {
  let fetchMock: ReturnType<typeof vi.fn<FetchFn>>
  beforeEach(() => {
    fetchMock = vi.fn<FetchFn>(async () => new Response(JSON.stringify({ ok: true, message: 'Allowed once. The agent continues.' })))
  })

  it('shows a push, with the approval buttons', async () => {
    const sw = load(fetchMock)
    await sw.dispatch('push', push({
      title: 'Morning news needs your approval', body: 'Create notes/a.md', link: '/c/1', tag: 'n1', kind: 'approval',
      actions: [{ action: 'approve', title: 'Allow once', token: 'tok-a' }, { action: 'deny', title: 'Deny', token: 'tok-d' }],
    }))
    const [note] = sw.shown
    expect(note.title).toBe('Morning news needs your approval')
    expect(note.options.tag).toBe('n1')
    expect(note.options.actions).toEqual([{ action: 'approve', title: 'Allow once' }, { action: 'deny', title: 'Deny' }])
    expect(note.options.data).toEqual({ link: '/c/1', tokens: { approve: 'tok-a', deny: 'tok-d' } })
    expect(note.options.requireInteraction).toBe(true)
  })

  it('never links outside the app', async () => {
    const sw = load(fetchMock)
    await sw.dispatch('push', push({ title: 'x', link: 'https://evil.example' }))
    await sw.dispatch('push', push({ title: 'y', link: '//evil.example/x' }))
    expect(sw.shown.map((n) => n.options.data.link)).toEqual(['/notifications', '/notifications'])
    expect(sw.shown[0].options.actions).toEqual([])
  })

  it('a button sends its token, without cookies, and says what happened', async () => {
    const sw = load(fetchMock)
    const close = vi.fn()
    await sw.dispatch('notificationclick', {
      action: 'approve',
      notification: { close, data: { link: '/c/1', tokens: { approve: 'tok-a', deny: 'tok-d' } } },
    })
    expect(close).toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/public/push/actions')
    expect(init.credentials).toBe('omit')
    expect(JSON.parse(init.body as string)).toEqual({ token: 'tok-a' })
    expect(sw.shown[0]).toMatchObject({ title: 'Answered', options: { body: 'Allowed once. The agent continues.' } })
    expect(sw.opened).toEqual([]) // answered without opening the app
  })

  it('a button that no longer works says so', async () => {
    fetchMock = vi.fn<FetchFn>(async () => new Response(JSON.stringify({ error: { code: 'push_action_gone', message: 'This button no longer works. Open Anemo to answer.' } }), { status: 404 }))
    const sw = load(fetchMock)
    await sw.dispatch('notificationclick', { action: 'deny', notification: { close: () => undefined, data: { link: '/c/1', tokens: { deny: 'tok-d' } } } })
    expect(sw.shown[0]).toMatchObject({ title: 'Not answered', options: { body: 'This button no longer works. Open Anemo to answer.' } })
  })

  it('a tap opens the page: in an open tab, or a new one', async () => {
    const sw = load(fetchMock)
    await sw.dispatch('notificationclick', { action: '', notification: { close: () => undefined, data: { link: '/tasks', tokens: {} } } })
    expect(sw.opened).toEqual(['/tasks'])

    const tab = { url: 'https://anemo.example/home', postMessage: vi.fn(), focus: vi.fn(async () => undefined) }
    sw.windows.push(tab)
    await sw.dispatch('notificationclick', { action: '', notification: { close: () => undefined, data: { link: '/c/2', tokens: {} } } })
    expect(tab.postMessage).toHaveBeenCalledWith({ type: 'anemo.navigate', path: '/c/2' })
    expect(tab.focus).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
