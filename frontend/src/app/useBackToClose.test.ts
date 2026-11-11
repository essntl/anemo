import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTopOverlay, openOverlays } from './overlays'
import { watchBack } from './useBackToClose'

/** Something open over the page that closes on Esc, as the app's dialogs and menus do. */
function overlay(role = 'dialog'): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('role', role)
  el.dataset.state = 'open'
  document.body.append(el)
  return el
}

/** Esc closes the one opened last, like the real layers. */
function closeOnEscape() {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    const open = [...document.querySelectorAll<HTMLElement>('[data-state="open"]')]
    open.at(-1)?.setAttribute('data-state', 'closed')
  }
  document.addEventListener('keydown', onKey)
  return () => document.removeEventListener('keydown', onKey)
}

/** Lets the mutation observer and the queued check run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

let stop: () => void = () => undefined
let stopEscape: () => void = () => undefined

beforeEach(() => {
  stopEscape = closeOnEscape()
})
afterEach(() => {
  stop()
  stopEscape()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('what counts as open over the page', () => {
  it('open dialogs, menus and lists, and what marks itself, but not closed or plain ones', () => {
    overlay('dialog')
    overlay('menu')
    overlay('listbox')
    overlay('dialog').dataset.state = 'closed'
    // A list on the page with that role, and a panel that is not a layer.
    document.body.append(Object.assign(document.createElement('ul'), { role: 'listbox' }))
    const island = document.createElement('div')
    island.dataset.overlay = 'open'
    document.body.append(island)
    expect(openOverlays()).toBe(4)
  })

  it('closing the top one is an Esc key press', () => {
    const first = overlay()
    const second = overlay()
    closeTopOverlay()
    expect(second.dataset.state).toBe('closed')
    expect(first.dataset.state).toBe('open')
  })
})

describe('back closes what is open (browsers with CloseWatcher)', () => {
  class FakeWatcher {
    static live: FakeWatcher[] = []
    onclose: (() => void) | null = null
    constructor() {
      FakeWatcher.live.push(this)
    }
    destroy() {
      FakeWatcher.live = FakeWatcher.live.filter((w) => w !== this)
    }
    /** The user's back gesture: the browser closes the watcher and tells it. */
    back() {
      this.destroy()
      this.onclose?.()
    }
  }
  beforeEach(() => {
    FakeWatcher.live = []
    vi.stubGlobal('CloseWatcher', FakeWatcher)
  })

  it('holds a watcher only while something is open', async () => {
    stop = watchBack()
    await settle()
    expect(FakeWatcher.live).toHaveLength(0)
    const sheet = overlay()
    await settle()
    expect(FakeWatcher.live).toHaveLength(1)
    sheet.dataset.state = 'closed'
    await settle()
    expect(FakeWatcher.live).toHaveLength(0)
  })

  it('one back per layer, the topmost first', async () => {
    stop = watchBack()
    const drawer = overlay()
    const menu = overlay('menu')
    await settle()
    FakeWatcher.live[0].back()
    await settle()
    expect(menu.dataset.state).toBe('closed')
    expect(drawer.dataset.state).toBe('open')
    // The drawer is still open: the next back is for it.
    expect(FakeWatcher.live).toHaveLength(1)
    FakeWatcher.live[0].back()
    await settle()
    expect(drawer.dataset.state).toBe('closed')
    expect(FakeWatcher.live).toHaveLength(0)
  })
})

describe('back closes what is open (browsers without CloseWatcher)', () => {
  beforeEach(() => {
    vi.stubGlobal('CloseWatcher', undefined)
    history.replaceState({ key: 'page' }, '')
  })
  const back = () => {
    history.replaceState({ key: 'page' }, '') // where a real back would land: the page's own entry
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  it('adds an entry while something is open, as a copy of the page’s own', async () => {
    const push = vi.spyOn(history, 'pushState')
    stop = watchBack()
    await settle()
    expect(push).not.toHaveBeenCalled()
    overlay()
    await settle()
    expect(push).toHaveBeenCalledTimes(1)
    expect(history.state).toMatchObject({ key: 'page', anemoOverlay: true })
  })

  it('back then closes the top layer, and adds an entry again for the one under it', async () => {
    const push = vi.spyOn(history, 'pushState')
    stop = watchBack()
    const drawer = overlay()
    const menu = overlay('menu')
    await settle()
    back()
    await settle()
    expect(menu.dataset.state).toBe('closed')
    expect(drawer.dataset.state).toBe('open')
    expect(push).toHaveBeenCalledTimes(2)
    back()
    await settle()
    expect(drawer.dataset.state).toBe('closed')
    expect(push).toHaveBeenCalledTimes(2)
  })

  it('a layer closed another way leaves its entry, which the next back steps over', async () => {
    const goBack = vi.spyOn(history, 'back').mockImplementation(() => undefined)
    const push = vi.spyOn(history, 'pushState')
    stop = watchBack()
    const sheet = overlay()
    await settle()
    sheet.dataset.state = 'closed' // tapped outside
    await settle()
    expect(goBack).not.toHaveBeenCalled()
    // Opening something else reuses that entry.
    const other = overlay()
    await settle()
    expect(push).toHaveBeenCalledTimes(1)
    other.dataset.state = 'closed'
    await settle()
    // Back now leaves the entry: that back was meant for the page, so it goes on.
    back()
    expect(goBack).toHaveBeenCalledTimes(1)
  })

  it('coming back onto a left-behind entry steps over it too', async () => {
    const goBack = vi.spyOn(history, 'back').mockImplementation(() => undefined)
    stop = watchBack()
    await settle()
    // As after following a link from a menu: our entry is behind the new page's, and back lands on it.
    history.replaceState({ key: 'page', anemoOverlay: true }, '')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(goBack).toHaveBeenCalledTimes(1)
  })
})
