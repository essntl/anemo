import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { contributionsOut } from '@/test/pluginFixtures'
import type { ContributionCommand, ContributionUi } from './types'

/* Plugins in Ctrl+K: their pages and commands, matched by what is typed, and what a command does. */

const call = vi.hoisted(() => vi.fn())
const confirm = vi.hoisted(() => vi.fn(async () => true))
const toast = vi.hoisted(() => vi.fn())
vi.mock('./api', async (original) => ({ ...(await original<typeof import('./api')>()), callPlugin: call }))
vi.mock('./host/confirm', () => ({ confirmPluginCall: confirm }))
vi.mock('@/components/ui/toast', () => ({ toast }))

const { pluginPaletteItems, runCommand } = await import('./palette')

const page: ContributionUi = {
  plugin: 'anemo.today-board', plugin_name: 'Today board', icon_url: null, version: '1.0.0', permissions: ['tasks:read'],
  id: 'today', slot: 'page', title: 'Today', icon: 'calendar-check', objects: null, fence: null, height: null, entry: 'ui/today.html',
}
const command = (action: ContributionCommand['action'], over: Partial<ContributionCommand> = {}): ContributionCommand => ({
  plugin: 'anemo.today-board', plugin_name: 'Today board', version: '1.0.0', id: 'open', title: 'Open Today board', icon: null, keywords: ['agenda'], action, ...over,
})

describe('plugins in the command palette', () => {
  afterEach(() => {
    call.mockReset()
    toast.mockReset()
    confirm.mockClear()
  })

  it('offers matching pages and commands once something is typed', () => {
    const data = contributionsOut({ ui: [page], commands: [command({ type: 'openPage', page: 'today' })] })
    expect(pluginPaletteItems(data, '')).toEqual({ actions: [], pages: [] })
    const found = pluginPaletteItems(data, 'agenda')
    expect(found.actions.map((a) => a.title)).toEqual(['Open Today board'])
    expect(found.pages).toEqual([])
    const pages = pluginPaletteItems(data, 'today')
    expect(pages.pages.map((p) => [p.title, p.to])).toEqual([['Today', '/plugins/anemo.today-board/today']])
  })

  it('offers nothing with the kill switch on', () => {
    const data = contributionsOut({ ui: [page], commands: [command({ type: 'openPage', page: 'today' })], disabled_all: true })
    expect(pluginPaletteItems(data, 'today')).toEqual({ actions: [], pages: [] })
  })

  it('opens a plugin page', async () => {
    const navigate = vi.fn()
    await runCommand(command({ type: 'openPage', page: 'today' }), null, navigate)
    expect(navigate).toHaveBeenCalledWith('/plugins/anemo.today-board/today')
  })

  it('runs a script and says it started', async () => {
    call.mockResolvedValue({ runId: 'r1' })
    await runCommand(command({ type: 'runScript', script: 'weekly', input: { a: 1 } }, { title: 'Run weekly review' }), null, vi.fn())
    expect(call).toHaveBeenCalledWith('anemo.today-board', { ui: null, method: 'scripts.run', params: { script: 'weekly', input: { a: 1 } } })
    expect(toast).toHaveBeenCalledWith({ message: '“Run weekly review” started. Its result will be in the run history.' })
  })

  it('creates from a template, asking first when the server says so, and offers to open it', async () => {
    call
      .mockRejectedValueOnce(new ApiError(409, 'confirm_required', 'OK?', { token: 'tok', summary: 'Create a document', risk: 'medium' }))
      .mockResolvedValueOnce({ type: 'document', id: 'd7' })
    const navigate = vi.fn()
    await runCommand(command({ type: 'newFromTemplate', template: 'review' }, { title: 'New weekly review' }), null, navigate)
    expect(confirm).toHaveBeenCalled()
    expect(call).toHaveBeenLastCalledWith('anemo.today-board', expect.objectContaining({ method: 'templates.apply', confirm_token: 'tok' }))
    const shown = toast.mock.calls[0][0] as { message: string; action: { onClick: () => void } }
    expect(shown.message).toBe('Created from “New weekly review”.')
    shown.action.onClick()
    expect(navigate).toHaveBeenCalledWith('/documents/d7')
  })

  it('does nothing but say so for an action this app does not know', async () => {
    const navigate = vi.fn()
    await runCommand(command({ type: 'openWindow', url: 'https://example.com' }), null, navigate)
    expect(navigate).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith({ message: 'Today board: this command needs a newer version of Anemo.' })
  })
})

describe('sendToUi commands', () => {
  afterEach(() => toast.mockReset())

  it('deliver the event to the plugin’s open frame of that UI, and say so when it isn’t open', async () => {
    const { registerFrame } = await import('./host/frames')
    const emit = vi.fn()
    const stop = registerFrame({ pluginId: 'anemo.today-board', ui: 'layer', emit })
    const toggle = command({ type: 'sendToUi', ui: 'layer', event: 'toggle' }, { title: 'Toggle' })
    await runCommand(toggle, null, vi.fn())
    expect(emit).toHaveBeenCalledWith('command', { event: 'toggle' })
    expect(toast).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    stop()
    await runCommand(toggle, null, vi.fn())
    expect(emit).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith({ message: expect.stringContaining('Toggle') })
  })
})
