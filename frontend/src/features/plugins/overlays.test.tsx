import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { matchingActions } from '@/features/search/actions'
import { contributionsOut, mockApi, renderWithProviders, stubMatchMedia } from '@/test/pluginFixtures'
import { PluginOverlays } from './overlays'
import { usePluginOverlays } from './overlayStore'
import type { ContributionUi } from './types'

/* Plugin overlays in the app shell: one frame per plugin with one, a click-through layer
 * below every dialog, hidden while a dialog is open, and hidden by the user from Ctrl+K. */

const overlay = (over: Partial<ContributionUi> = {}): ContributionUi => ({
  plugin: 'artem.layer', plugin_name: 'Layer', icon_url: null, version: '1.0.0', permissions: [],
  id: 'layer', slot: 'overlay', title: 'Layer', icon: null, objects: null, fence: null, height: null, entry: 'ui/layer.html', ...over,
})

const frameOf = () => document.querySelector('iframe[data-plugin-frame="artem.layer"]') as HTMLIFrameElement | null

describe('plugin overlays', () => {
  beforeEach(() => {
    stubMatchMedia()
    localStorage.clear()
    usePluginOverlays.setState({ hidden: false, count: 0 })
    mockApi({
      'GET /api/plugins/contributions': () => contributionsOut({ ui: [overlay(), overlay({ plugin: 'artem.panel', id: 'p', slot: 'object.panel', objects: ['task'] })] }),
      'GET /api/plugins/artem.layer/versions/1.0.0/ui/layer': () => ({ entry: 'ui/layer.html', html: '', scripts: [], styles: [], hash: 'h', pictures: [] }),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.querySelectorAll('[role="dialog"]').forEach((d) => d.remove())
  })

  it('draws one sandboxed, click-through, window-sized frame per overlay, out of the Tab order', async () => {
    renderWithProviders(<PluginOverlays />)
    await waitFor(() => expect(frameOf()).not.toBeNull())
    const frame = frameOf() as HTMLIFrameElement
    expect(document.querySelectorAll('iframe')).toHaveLength(1)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.style.pointerEvents).toBe('none')
    expect(frame.style.visibility).toBe('visible')
    expect(frame.tabIndex).toBe(-1)
    expect(frame.className).toContain('fixed')
    // Above the page (z-30 at most) and below dialogs (z-40 and up).
    expect(frame.className).toContain('z-[35]')
    expect(usePluginOverlays.getState().count).toBe(1)
  })

  it('starts: its own frame’s hello gets init, with the overlay context and the layout', async () => {
    renderWithProviders(<PluginOverlays />)
    await waitFor(() => expect(frameOf()).not.toBeNull())
    const win = (frameOf() as HTMLIFrameElement).contentWindow as Window
    const postMessage = vi.spyOn(win, 'postMessage').mockImplementation(() => {})
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { anemo: 1, type: 'hello' }, source: win }))
    })
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1))
    const [message, , transfer] = postMessage.mock.calls[0] as unknown as [Record<string, unknown>, string, MessagePort[]]
    expect(message).toMatchObject({ type: 'init', slot: 'overlay', ui: 'layer', context: { overlay: true } })
    expect(message.layout).toMatchObject({ viewport: expect.any(Object), anchors: expect.any(Object) })
    expect(message.theme).toMatchObject({ reducedMotion: expect.any(Boolean) })
    transfer[0].close()
  })

  it('is hidden while a dialog is open, and comes back after', async () => {
    renderWithProviders(<PluginOverlays />)
    await waitFor(() => expect(frameOf()).not.toBeNull())
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'alertdialog')
    dialog.dataset.state = 'open'
    await act(async () => {
      document.body.append(dialog)
    })
    await waitFor(() => expect(frameOf()?.style.visibility).toBe('hidden'))
    await act(async () => {
      dialog.dataset.state = 'closed'
    })
    await waitFor(() => expect(frameOf()?.style.visibility).toBe('visible'))
  })

  it('can be hidden and shown again from Ctrl+K, remembered on this device', async () => {
    renderWithProviders(<PluginOverlays />)
    await waitFor(() => expect(frameOf()).not.toBeNull())
    expect(matchingActions('overlays').map((a) => a.label)).toEqual(['Hide plugin overlays'])
    act(() => matchingActions('hide overlays')[0].run(vi.fn()))
    await waitFor(() => expect(frameOf()).toBeNull())
    expect(JSON.parse(localStorage.getItem('anemo.pluginOverlays') ?? '{}').state).toEqual({ hidden: true })
    expect(matchingActions('overlays').map((a) => a.label)).toEqual(['Show plugin overlays'])
    act(() => matchingActions('show overlays')[0].run(vi.fn()))
    await waitFor(() => expect(frameOf()).not.toBeNull())
  })

  it('offers no overlay command when no plugin has one', () => {
    usePluginOverlays.setState({ hidden: false, count: 0 })
    expect(matchingActions('overlays')).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
