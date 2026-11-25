import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { type ChannelOptions, clampHeight, MAX_IN_FLIGHT, PluginChannel, type PortLike, RATE_PER_MINUTE } from './channel'
import { checkCall, hostAllowed } from './methods'

/* The host's end of a frame's port: the checks of contract §6.4, in the page. */

/** A port that records what the host sends and lets the test play the frame. */
function fakePort() {
  let listener: ((event: MessageEvent) => void) | null = null
  const sent: unknown[] = []
  const port: PortLike = {
    postMessage: (m) => void sent.push(m),
    addEventListener: (_type, l) => { listener = l },
    removeEventListener: () => { listener = null },
  }
  const send = (data: unknown) => listener?.({ data } as MessageEvent)
  return { port, sent, send }
}

function channel(over: Partial<ChannelOptions> = {}) {
  const fake = fakePort()
  const options: ChannelOptions = {
    pluginId: 'anemo.word-count',
    ui: 'panel',
    slot: 'object.panel',
    permissions: ['documents:read'],
    pages: ['today'],
    previewVersion: null,
    active: () => true,
    context: () => ({ object: { type: 'document', id: 'd1' } }),
    call: vi.fn(async () => ({ ok: true })),
    confirm: vi.fn(async () => true),
    resize: vi.fn(),
    toast: vi.fn(),
    open: vi.fn(),
    ...over,
  }
  const host = new PluginChannel(fake.port, options)
  return { host, options, ...fake }
}

describe('the host channel', () => {
  it('forwards an allowed call to the server and answers with its result', async () => {
    const { host, options, sent } = channel()
    await host.receive({ id: 1, method: 'documents.get', params: { id: 'd1' } })
    expect(options.call).toHaveBeenCalledWith({ ui: 'panel', method: 'documents.get', params: { id: 'd1' } })
    expect(sent).toEqual([{ id: 1, result: { ok: true } }])
  })

  it('refuses a method the approved manifest does not allow, without asking the server', async () => {
    const { host, options, sent } = channel()
    await host.receive({ id: 2, method: 'tasks.create', params: { title: 'x' } })
    expect(options.call).not.toHaveBeenCalled()
    expect(sent).toEqual([{ id: 2, error: { code: 'permission_denied', message: expect.stringContaining('tasks:write') } }])
  })

  it('answers unknown methods and ignores messages that are not requests', async () => {
    const { host, sent } = channel()
    await host.receive({ id: 3, method: 'settings.get' })
    await host.receive('hello')
    await host.receive({ method: 'tasks.list' })
    expect(sent).toEqual([{ id: 3, error: { code: 'unknown_method', message: expect.any(String) } }])
  })

  it('answers "unavailable" while the plugin is off or the kill switch is on', async () => {
    const { host, options, sent } = channel({ active: () => false })
    await host.receive({ id: 4, method: 'storage.get', params: { key: 'a' } })
    expect(options.call).not.toHaveBeenCalled()
    expect(sent).toEqual([{ id: 4, error: { code: 'unavailable', message: expect.any(String) } }])
  })

  it('allows 120 requests a minute, then refuses until the minute has passed', async () => {
    let now = 0
    const { host, sent } = channel({ now: () => now })
    for (let i = 0; i < RATE_PER_MINUTE; i++) await host.receive({ id: i, method: 'context.get' })
    await host.receive({ id: 'over', method: 'context.get' })
    expect(sent.at(-1)).toEqual({ id: 'over', error: { code: 'rate_limited', message: expect.any(String) } })
    now = 60_000
    await host.receive({ id: 'later', method: 'context.get' })
    expect(sent.at(-1)).toEqual({ id: 'later', result: { object: { type: 'document', id: 'd1' } } })
  })

  it('allows at most 8 requests waiting for an answer at once', async () => {
    const answers: (() => void)[] = []
    const call = vi.fn(() => new Promise((resolve) => answers.push(() => resolve({}))))
    const { host, sent } = channel({ call })
    const waiting = Array.from({ length: MAX_IN_FLIGHT }, (_, i) => host.receive({ id: i, method: 'documents.list' }))
    await host.receive({ id: 'ninth', method: 'documents.list' })
    expect(sent).toEqual([{ id: 'ninth', error: { code: 'rate_limited', message: expect.any(String) } }])
    answers.forEach((answer) => answer())
    await Promise.all(waiting)
    expect(sent).toHaveLength(MAX_IN_FLIGHT + 1)
  })

  it('asks the user when the server needs a confirmation, and sends the token only to the server', async () => {
    const token = 'one-time-secret-token'
    const call = vi.fn()
      .mockRejectedValueOnce(new ApiError(403, 'confirm_required', 'Needs your OK', { token, summary: 'Run shell command “ls”', risk: 'critical' }))
      .mockResolvedValueOnce({ content: 'done' })
    const confirm = vi.fn(async () => true)
    const { host, sent } = channel({ call, confirm, permissions: ['tools:shell_run'] })
    await host.receive({ id: 9, method: 'tools.call', params: { name: 'shell_run', args: {} } })
    expect(confirm).toHaveBeenCalledWith({ summary: 'Run shell command “ls”', risk: 'critical' })
    expect(call).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'tools.call', confirm_token: token }))
    expect(sent).toEqual([{ id: 9, result: { content: 'done' } }])
    // Nothing the frame received carries the token.
    expect(JSON.stringify(sent)).not.toContain(token)
  })

  it('answers "declined" when the user says no', async () => {
    const call = vi.fn().mockRejectedValue(new ApiError(403, 'confirm_required', 'Needs your OK', { token: 't', summary: 'Send it', risk: 'high' }))
    const { host, sent } = channel({ call, confirm: async () => false, permissions: ['notifications:send'] })
    await host.receive({ id: 10, method: 'notifications.send', params: { title: 'Hi' } })
    expect(call).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([{ id: 10, error: { code: 'declined', message: expect.any(String) } }])
  })

  it('sends the previewed version with every call of a preview', async () => {
    const { host, options } = channel({ previewVersion: '1.1.0' })
    await host.receive({ id: 11, method: 'documents.list' })
    expect(options.call).toHaveBeenCalledWith(expect.objectContaining({ preview_version: '1.1.0' }))
  })

  it('maps server errors to the codes a frame knows', async () => {
    const { host, sent } = channel({ call: vi.fn().mockRejectedValue(new ApiError(404, 'document_not_found', 'No such document')) })
    await host.receive({ id: 12, method: 'documents.get', params: { id: 'x' } })
    expect(sent).toEqual([{ id: 12, error: { code: 'not_found', message: 'No such document' } }])
  })

  it('resizes panels within 40–2000 px, and leaves pages alone', async () => {
    const { host, options, sent } = channel()
    await host.receive({ id: 13, method: 'ui.resize', params: { height: 99999 } })
    await host.receive({ id: 14, method: 'ui.resize', params: { height: 3 } })
    expect(options.resize).toHaveBeenNthCalledWith(1, 2000)
    expect(options.resize).toHaveBeenNthCalledWith(2, 40)
    expect(sent).toEqual([{ id: 13, result: {} }, { id: 14, result: {} }])
    const page = channel({ slot: 'page' })
    await page.host.receive({ id: 15, method: 'ui.resize', params: { height: 300 } })
    expect(page.options.resize).not.toHaveBeenCalled()
    expect(clampHeight(321.6)).toBe(322)
  })

  it('shows a toast as plain, short text', async () => {
    const { host, options } = channel()
    await host.receive({ id: 16, method: 'ui.toast', params: { message: `  ${'x'.repeat(300)}  ` } })
    expect(options.toast).toHaveBeenCalledWith('x'.repeat(200), 'info')
  })

  it('opens only what the plugin may read, and only its own pages', async () => {
    const { host, options, sent } = channel()
    await host.receive({ id: 17, method: 'ui.open', params: { type: 'document', id: 'd2' } })
    await host.receive({ id: 18, method: 'ui.open', params: { type: 'task', id: 't1' } })
    await host.receive({ id: 19, method: 'ui.open', params: { type: 'page', id: 'today' } })
    await host.receive({ id: 20, method: 'ui.open', params: { type: 'page', id: 'elsewhere' } })
    expect(options.open).toHaveBeenCalledWith('document', 'd2')
    expect(options.open).toHaveBeenCalledWith('page', 'today')
    expect(options.open).toHaveBeenCalledTimes(2)
    expect(sent).toContainEqual({ id: 18, error: { code: 'permission_denied', message: expect.any(String) } })
    expect(sent).toContainEqual({ id: 20, error: { code: 'not_found', message: expect.any(String) } })
  })

  it('stops answering once closed', async () => {
    const { host, sent, send } = channel()
    host.close()
    send({ id: 21, method: 'context.get' })
    await host.receive({ id: 22, method: 'context.get' })
    expect(sent).toEqual([])
  })
})

describe('the method table', () => {
  it('checks network hosts, with *. for subdomains only', () => {
    expect(hostAllowed('api.example.com', ['network:api.example.com'])).toBe(true)
    expect(hostAllowed('evil.com', ['network:api.example.com'])).toBe(false)
    expect(hostAllowed('a.example.com', ['network:*.example.com'])).toBe(true)
    expect(hostAllowed('example.com', ['network:*.example.com'])).toBe(false)
    expect(hostAllowed('badexample.com', ['network:*.example.com'])).toBe(false)
  })

  it('needs network:<host> for http.fetch and tools:<name> for tools.call', () => {
    expect(checkCall('http.fetch', { url: 'https://api.example.com/x' }, ['network:api.example.com'])).toBeNull()
    expect(checkCall('http.fetch', { url: 'https://other.com/x' }, ['network:api.example.com'])?.code).toBe('permission_denied')
    expect(checkCall('http.fetch', { url: 'file:///etc/passwd' }, ['network:api.example.com'])?.code).toBe('invalid_params')
    expect(checkCall('tools.call', { name: 'list_tasks' }, ['tools:list_tasks'])).toBeNull()
    expect(checkCall('tools.call', { name: 'shell_run' }, ['tools:list_tasks'])?.code).toBe('permission_denied')
    expect(checkCall('templates.apply', { template: 't' }, ['tasks:write'])).toBeNull()
    expect(checkCall('storage.set', { key: 'k', value: 1 }, [])).toBeNull()
  })
})
