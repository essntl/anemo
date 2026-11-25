import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ChannelOptions, inRegions, MAX_ASSET_MESSAGE, MAX_HIT_REGIONS, MAX_HIT_SIZE, parseHitRegions, parsePickOptions, PluginChannel, type PortLike } from './channel'
import { watchComposer } from './activity'
import { anyDialogOpen, watchDialogs } from './dialogWatch'
import { announceWrite, openFrames, registerFrame, sendToUi } from './frames'
import { HitRegions } from './hitRegions'
import { measureLayout } from './layout'
import { checkCall } from './methods'
import { MAX_PICK_BYTES, PickError, readPicked, sniffImage } from './pickFile'

/* The host's side of the platform additions: overlay hit regions and visibility, layout,
 * the file picker, assets and the fan-out of writes to a plugin's other frames. */

function fakePort() {
  let listener: ((event: MessageEvent) => void) | null = null
  const sent: unknown[] = []
  const port: PortLike = {
    postMessage: (m) => void sent.push(m),
    addEventListener: (_type, l) => { listener = l },
    removeEventListener: () => { listener = null },
  }
  return { port, sent, send: (data: unknown) => listener?.({ data } as MessageEvent) }
}

function channel(over: Partial<ChannelOptions> = {}) {
  const fake = fakePort()
  const options: ChannelOptions = {
    pluginId: 'artem.layer',
    ui: 'layer',
    slot: 'overlay',
    permissions: [],
    pages: [],
    previewVersion: null,
    active: () => true,
    context: () => ({ overlay: true }),
    call: vi.fn(async () => ({})),
    confirm: vi.fn(async () => true),
    resize: vi.fn(),
    toast: vi.fn(),
    open: vi.fn(),
    setHitRegions: vi.fn(),
    setVisible: vi.fn(),
    pointer: vi.fn(),
    ...over,
  }
  return { host: new PluginChannel(fake.port, options), options, ...fake }
}

const region = (over: Record<string, unknown> = {}) => ({ x: 10, y: 20, width: 100, height: 80, ...over })

describe('ui.setHitRegions', () => {
  it('passes checked regions to the overlay and answers {}', async () => {
    const { host, options, sent } = channel()
    await host.receive({ id: 1, method: 'ui.setHitRegions', params: { regions: [region()] } })
    expect(options.setHitRegions).toHaveBeenCalledWith([region()])
    expect(sent).toEqual([{ id: 1, result: {} }])
    await host.receive({ id: 2, method: 'ui.setHitRegions', params: { regions: [] } })
    expect(options.setHitRegions).toHaveBeenLastCalledWith([])
  })

  it.each([
    ['too many', { regions: Array.from({ length: MAX_HIT_REGIONS + 1 }, () => region()) }],
    ['too wide', { regions: [region({ width: MAX_HIT_SIZE + 1 })] }],
    ['too tall', { regions: [region({ height: MAX_HIT_SIZE + 1 })] }],
    ['empty', { regions: [region({ width: 0 })] }],
    ['not a number', { regions: [region({ x: '10' })] }],
    ['infinite', { regions: [region({ y: Infinity })] }],
    ['an unknown field', { regions: [region({ z: 1 })] }],
    ['an unknown param', { regions: [], extra: true }],
    ['no list', { regions: region() }],
  ])('refuses %s with invalid_params', async (_name, params) => {
    const { host, options, sent } = channel()
    await host.receive({ id: 1, method: 'ui.setHitRegions', params })
    expect(options.setHitRegions).not.toHaveBeenCalled()
    expect(sent).toEqual([{ id: 1, error: { code: 'invalid_params', message: expect.any(String) } }])
  })

  it('accepts exactly the limits', () => {
    const max = Array.from({ length: MAX_HIT_REGIONS }, () => region({ width: MAX_HIT_SIZE, height: MAX_HIT_SIZE }))
    expect(parseHitRegions({ regions: max })).toHaveLength(MAX_HIT_REGIONS)
  })

  it('is only for overlays', async () => {
    const { host, sent } = channel({ slot: 'object.panel' })
    await host.receive({ id: 1, method: 'ui.setHitRegions', params: { regions: [region()] } })
    await host.receive({ id: 2, method: 'ui.setVisible', params: { visible: false } })
    expect(sent).toEqual([
      { id: 1, error: { code: 'invalid_params', message: 'Only an overlay has hit regions.' } },
      { id: 2, error: { code: 'invalid_params', message: 'Only an overlay can hide and show itself.' } },
    ])
  })
})

describe('ui.setVisible and the pointer reports', () => {
  it('lets the overlay hide and show itself; the value must be a boolean', async () => {
    const { host, options, sent } = channel()
    await host.receive({ id: 1, method: 'ui.setVisible', params: { visible: false } })
    await host.receive({ id: 2, method: 'ui.setVisible', params: { visible: 'no' } })
    await host.receive({ id: 3, method: 'ui.setVisible', params: { visible: true, now: 1 } })
    expect(options.setVisible).toHaveBeenCalledExactlyOnceWith(false)
    expect(sent).toEqual([
      { id: 1, result: {} },
      { id: 2, error: { code: 'invalid_params', message: expect.any(String) } },
      { id: 3, error: { code: 'invalid_params', message: expect.stringContaining('"now"') } },
    ])
  })

  it('takes the bootstrap’s pointer reports without answering them or counting them', async () => {
    const { host, options, sent } = channel()
    await host.receive({ pointer: { x: 5, y: 6 } })
    await host.receive({ pointer: null })
    await host.receive({ pointer: { x: 'a', y: 1 } })
    expect(options.pointer).toHaveBeenNthCalledWith(1, { x: 5, y: 6 })
    expect(options.pointer).toHaveBeenNthCalledWith(2, null)
    expect(options.pointer).toHaveBeenCalledTimes(2)
    expect(sent).toEqual([])
  })

  it('ignores pointer reports from a frame that is not an overlay', async () => {
    const { host, options } = channel({ slot: 'page' })
    await host.receive({ pointer: { x: 5, y: 6 } })
    expect(options.pointer).not.toHaveBeenCalled()
  })
})

describe('HitRegions', () => {
  it('takes the pointer only inside a region, and lets it through again outside', () => {
    const apply = vi.fn()
    const hits = new HitRegions(apply)
    hits.move({ x: 50, y: 50 })
    expect(apply).not.toHaveBeenCalled() // no regions: always click-through
    hits.set([region()])
    expect(apply).toHaveBeenLastCalledWith(true) // the pointer already stands inside
    hits.move({ x: 200, y: 50 })
    expect(apply).toHaveBeenLastCalledWith(false)
    hits.move({ x: 60, y: 60 })
    expect(apply).toHaveBeenLastCalledWith(true)
    hits.move(null) // it left the window
    expect(apply).toHaveBeenLastCalledWith(false)
    expect(apply).toHaveBeenCalledTimes(4)
  })

  it('never takes the pointer while the overlay is hidden', () => {
    const apply = vi.fn()
    const hits = new HitRegions(apply)
    hits.set([region()])
    hits.move({ x: 50, y: 50 })
    hits.setEnabled(false)
    expect(apply).toHaveBeenLastCalledWith(false)
    hits.move({ x: 51, y: 51 })
    expect(hits.isTaking).toBe(false)
    hits.setEnabled(true)
    expect(apply).toHaveBeenLastCalledWith(true)
  })

  it('treats a region as half-open: its right and bottom edges are outside', () => {
    expect(inRegions([region()], 10, 20)).toBe(true)
    expect(inRegions([region()], 110, 50)).toBe(false)
    expect(inRegions([region()], 50, 100)).toBe(false)
  })
})

describe('hiding overlays while a dialog is open', () => {
  afterEach(() => document.body.replaceChildren())

  it('sees open dialogs, alert dialogs, the opened Island and reviews', () => {
    expect(anyDialogOpen()).toBe(false)
    for (const html of [
      '<div role="dialog" data-state="open"></div>',
      '<div role="alertdialog" data-state="open"></div>',
      '<div data-overlay="open"></div>',
      '<div data-hides-plugin-overlays></div>',
    ]) {
      document.body.innerHTML = html
      expect(anyDialogOpen()).toBe(true)
    }
    document.body.innerHTML = '<div role="dialog" data-state="closed"></div><div role="menu" data-state="open"></div>'
    expect(anyDialogOpen()).toBe(false)
  })

  it('reports a dialog opening and closing', async () => {
    const changes: boolean[] = []
    const stop = watchDialogs((open) => changes.push(open))
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'alertdialog')
    dialog.dataset.state = 'open'
    document.body.append(dialog)
    await Promise.resolve()
    dialog.dataset.state = 'closed'
    await Promise.resolve()
    stop()
    expect(changes).toEqual([true, false])
  })
})

describe('layout.get', () => {
  afterEach(() => document.body.replaceChildren())

  it('measures the anchors that are on screen, in viewport pixels', () => {
    document.body.innerHTML = '<div data-plugin-anchor="composer"></div><div data-plugin-anchor="sidebar"></div><div data-plugin-anchor="unknown"></div>'
    const [composer, sidebar] = document.querySelectorAll('div')
    composer.getBoundingClientRect = () => ({ x: 300, y: 600, width: 500, height: 80 }) as DOMRect
    sidebar.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect // display: none
    const layout = measureLayout()
    expect(layout.anchors).toEqual({ composer: { x: 300, y: 600, width: 500, height: 80 } })
    expect(layout.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight })
    expect(layout.route).toBe(window.location.pathname)
  })

  it('is answered by the page, with no params', async () => {
    const layout = { viewport: { width: 1, height: 2 }, anchors: {}, route: '/' }
    const { host, sent } = channel({ slot: 'page', layout: () => layout })
    await host.receive({ id: 1, method: 'layout.get', params: {} })
    await host.receive({ id: 2, method: 'layout.get', params: { anchor: 'composer' } })
    expect(sent).toEqual([{ id: 1, result: layout }, { id: 2, error: { code: 'invalid_params', message: expect.any(String) } }])
    expect(checkCall('layout.get', {}, [])).toBeNull()
  })
})

describe('the plugin’s own data', () => {
  it('tells the plugin’s other frames about a write, never the writer or another plugin', async () => {
    const own = { pluginId: 'artem.layer', ui: 'settings', emit: vi.fn() }
    const sibling = { pluginId: 'artem.layer', ui: 'layer', emit: vi.fn() }
    const stranger = { pluginId: 'artem.other', ui: 'layer', emit: vi.fn() }
    const stops = [own, sibling, stranger].map(registerFrame)
    const { host } = channel({ ui: 'settings', slot: 'settings', wrote: (area, key) => announceWrite(own, area, key) })
    await host.receive({ id: 1, method: 'storage.set', params: { key: 'speed', value: 2 } })
    await host.receive({ id: 2, method: 'assets.set', params: { key: 'sprite', dataUrl: 'data:image/gif;base64,R0lG' } })
    await host.receive({ id: 3, method: 'storage.get', params: { key: 'speed' } })
    expect(sibling.emit.mock.calls).toEqual([['storage.changed', { key: 'speed' }], ['assets.changed', { key: 'sprite' }]])
    expect(own.emit).not.toHaveBeenCalled()
    expect(stranger.emit).not.toHaveBeenCalled()
    stops.forEach((stop) => stop())
    expect(openFrames('artem.layer')).toEqual([])
  })

  it('does not announce a write the server refused', async () => {
    const wrote = vi.fn()
    const { host } = channel({ wrote, call: vi.fn(async () => { throw new Error('down') }) })
    await host.receive({ id: 1, method: 'storage.set', params: { key: 'k', value: 1 } })
    expect(wrote).not.toHaveBeenCalled()
  })

  it('lets assets.set carry a picture larger than 1 MB, but not more than 10 MB', async () => {
    const { host, options, sent } = channel()
    const dataUrl = `data:image/png;base64,${'A'.repeat(2_000_000)}`
    await host.receive({ id: 1, method: 'assets.set', params: { key: 'k', dataUrl } })
    await host.receive({ id: 2, method: 'storage.set', params: { key: 'k', value: 'A'.repeat(2_000_000) } })
    await host.receive({ id: 3, method: 'assets.set', params: { key: 'k', dataUrl: 'A'.repeat(MAX_ASSET_MESSAGE) } })
    expect(options.call).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([
      { id: 1, result: {} },
      { id: 2, error: { code: 'invalid_params', message: 'A message may be at most 1 MB.' } },
      { id: 3, error: { code: 'invalid_params', message: 'An asset may be at most 10 MB.' } },
    ])
  })

  it('needs no permission for assets', () => {
    for (const method of ['assets.get', 'assets.set', 'assets.delete', 'assets.list']) expect(checkCall(method, {}, [])).toBeNull()
  })
})

describe('sendToUi', () => {
  it('delivers the command to the open frames of that UI only', () => {
    const layer = { pluginId: 'artem.layer', ui: 'layer', emit: vi.fn() }
    const settings = { pluginId: 'artem.layer', ui: 'settings', emit: vi.fn() }
    const stops = [layer, settings].map(registerFrame)
    expect(sendToUi('artem.layer', 'layer', 'toggle')).toBe(true)
    expect(layer.emit).toHaveBeenCalledWith('command', { event: 'toggle' })
    expect(settings.emit).not.toHaveBeenCalled()
    expect(sendToUi('artem.layer', 'page', 'toggle')).toBe(false)
    stops.forEach((stop) => stop())
  })
})

describe('ui.pickFile', () => {
  it('checks its params: pictures only, at most 10 MB, no unknown params', () => {
    expect(parsePickOptions({})).toEqual({ accept: ['image/png', 'image/webp', 'image/gif', 'image/jpeg'], maxBytes: MAX_PICK_BYTES })
    expect(parsePickOptions({ accept: ['image/gif'], maxBytes: 50 * MAX_PICK_BYTES })).toEqual({ accept: ['image/gif'], maxBytes: MAX_PICK_BYTES })
    expect(() => parsePickOptions({ accept: ['image/svg+xml'] })).toThrow()
    expect(() => parsePickOptions({ accept: [] })).toThrow()
    expect(() => parsePickOptions({ maxBytes: -1 })).toThrow()
    expect(() => parsePickOptions({ multiple: true })).toThrow()
  })

  it('is answered by the page’s picker; a cancel is "declined"', async () => {
    const picked = { name: 'a.gif', type: 'image/gif', size: 3, dataUrl: 'data:image/gif;base64,R0lG' }
    const pickFile = vi.fn().mockResolvedValueOnce(picked).mockRejectedValueOnce(new PickError('declined', 'No file was chosen.'))
    const { host, sent } = channel({ slot: 'settings', pickFile })
    await host.receive({ id: 1, method: 'ui.pickFile', params: { accept: ['image/gif'] } })
    await host.receive({ id: 2, method: 'ui.pickFile', params: {} })
    expect(pickFile).toHaveBeenCalledWith({ accept: ['image/gif'], maxBytes: MAX_PICK_BYTES })
    expect(sent).toEqual([{ id: 1, result: picked }, { id: 2, error: { code: 'declined', message: 'No file was chosen.' } }])
  })

  it('knows pictures by their first bytes', () => {
    const bytes = (...b: number[]) => new Uint8Array(b)
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png')
    expect(sniffImage(new TextEncoder().encode('GIF89a'))).toBe('image/gif')
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(new TextEncoder().encode('<svg xmlns='))).toBeNull()
  })

  it('refuses a file whose content isn’t an accepted picture, or that is too large', async () => {
    const gif = new File([new TextEncoder().encode('GIF89a......')], 'a.png', { type: 'image/png' })
    const read = await readPicked(gif, { accept: ['image/gif'], maxBytes: 100 })
    expect(read.type).toBe('image/gif') // by its content, not its name
    expect(read.dataUrl.startsWith('data:image/gif;base64,')).toBe(true)
    await expect(readPicked(gif, { accept: ['image/png'], maxBytes: 100 })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(readPicked(gif, { accept: ['image/gif'], maxBytes: 4 })).rejects.toMatchObject({ code: 'invalid_params' })
    const svg = new File(['<svg/>'], 'a.gif', { type: 'image/gif' })
    await expect(readPicked(svg, { accept: ['image/gif'], maxBytes: 100 })).rejects.toMatchObject({ code: 'invalid_params' })
  })
})

describe('composer.activity', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it('reports focus, typing, a pause and blur of the message box, never its text', () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div data-plugin-anchor="composer"><textarea></textarea><button>Send</button></div><input id="other">'
    const states: string[] = []
    const stop = watchComposer((s) => states.push(s))
    const box = document.querySelector('textarea') as HTMLTextAreaElement
    box.focus()
    box.dispatchEvent(new Event('input', { bubbles: true }))
    vi.advanceTimersByTime(2000)
    ;(document.querySelector('button') as HTMLButtonElement).focus() // still inside the box
    ;(document.getElementById('other') as HTMLInputElement).focus()
    stop()
    expect(states).toEqual(['focused', 'typing', 'idle', 'blurred'])
  })
})

describe('theme.reducedMotion', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('follows prefers-reduced-motion', async () => {
    const { currentTheme } = await import('./theme')
    const stub = (reduce: boolean) =>
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('reduce'), media: query, addEventListener: () => {}, removeEventListener: () => {} }))
    stub(true)
    expect(currentTheme().reducedMotion).toBe(true)
    stub(false)
    expect(currentTheme().reducedMotion).toBe(false)
  })
})
