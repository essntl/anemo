import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockApi, renderWithProviders } from '@/test/pluginFixtures'
import { useFrameIncidents } from './incidents'
import { FRAME_URL, PluginFrame } from './PluginFrame'

/* The frame and its handshake (contract §6.1–§6.2): the sandbox, who may say hello, the
 * init with its port and files, and removal when the frame navigates away. */

const bundle = { entry: 'ui/panel.html', html: '<p>Hi</p>', scripts: [{ path: 'ui/panel.js', text: 'anemo.ready' }], styles: [], hash: 'h' }

function show(props: Partial<Parameters<typeof PluginFrame>[0]> = {}) {
  return renderWithProviders(
    <PluginFrame plugin={{ id: 'anemo.word-count', name: 'Word count', iconUrl: null, version: '1.0.0' }} ui="panel" slot="object.panel"
      permissions={['documents:read']} context={{ object: { type: 'document', id: 'd1' } }} active height={140} {...props} />,
  )
}

const frameOf = () => document.querySelector('iframe') as HTMLIFrameElement

/** A message to the page, as if `source` had posted it. */
function post(data: unknown, source: Window | null) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source }))
  })
}

describe('PluginFrame', () => {
  beforeEach(() => {
    mockApi({ 'GET /api/plugins/anemo.word-count/versions/1.0.0/ui/panel': () => bundle })
    useFrameIncidents.setState({ byPlugin: {} })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('makes a sandboxed frame with scripts only, no features and no referrer', () => {
    show()
    const frame = frameOf()
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('src')).toBe(FRAME_URL)
    expect(frame.getAttribute('allow')).toBe('')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.style.height).toBe('140px')
  })

  it('answers hello only from its own frame, with init, the files and a port', async () => {
    show()
    const frame = frameOf()
    const win = frame.contentWindow as Window
    const postMessage = vi.spyOn(win, 'postMessage').mockImplementation(() => {})

    // Another window saying hello (another plugin's frame, a stray page) is ignored.
    post({ anemo: 1, type: 'hello' }, window)
    await new Promise((r) => setTimeout(r, 0))
    expect(postMessage).not.toHaveBeenCalled()

    post({ anemo: 1, type: 'hello' }, win)
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1))
    const [message, target, transfer] = postMessage.mock.calls[0] as unknown as [Record<string, unknown>, string, MessagePort[]]
    expect(target).toBe('*')
    expect(message).toMatchObject({
      anemo: 1,
      type: 'init',
      plugin: { id: 'anemo.word-count', version: '1.0.0' },
      slot: 'object.panel',
      ui: 'panel',
      context: { object: { type: 'document', id: 'd1' } },
      preview: false,
      files: bundle,
      locale: 'en',
    })
    expect(message.theme).toMatchObject({ mode: expect.any(String), vars: expect.any(Object) })
    // The user's time zone: the browser's while Settings > General isn't in the cache.
    expect(message.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(transfer).toHaveLength(1)
    expect(transfer[0]).toBeInstanceOf(MessagePort)
    transfer[0].close()

    // A second hello (the same frame, reloaded) gets nothing more.
    post({ anemo: 1, type: 'hello' }, win)
    await new Promise((r) => setTimeout(r, 0))
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('removes the frame and says so when it loads a second document', () => {
    show()
    const frame = frameOf()
    fireEvent.load(frame) // the frame document
    expect(frameOf()).not.toBeNull()
    fireEvent.load(frame) // it navigated somewhere else
    expect(document.querySelector('iframe')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Word count tried to open another address inside its frame, so Anemo closed it.')
    expect(useFrameIncidents.getState().byPlugin['anemo.word-count']).toEqual([{ ui: 'panel', at: expect.any(Number) }])
  })

  it('shows the fallback (a chat block’s code) until the plugin has started', () => {
    show({ slot: 'chat.block', fallback: <pre>the code</pre> })
    expect(screen.getByText('the code')).toBeInTheDocument()
    expect(frameOf().className).toContain('invisible')
  })
})
