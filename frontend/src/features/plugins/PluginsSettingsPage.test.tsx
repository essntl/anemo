import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detailOut, mockApi, permission, pluginOut, renderRoutes, stubMatchMedia, versionOut } from '@/test/pluginFixtures'
import { PluginsSettingsPage } from './PluginsSettingsPage'
import type { PluginListOut } from './types'

/* Settings > Plugins: the grid of cards with their badges, the switches, the kill switch
 * and the empty state with the bundled examples. */

let list: PluginListOut

function show() {
  return renderRoutes([
    { path: '/settings/plugins', element: <PluginsSettingsPage /> },
    { path: '/settings/plugins/:pluginId', element: <p>Detail page</p> },
  ], '/settings/plugins')
}

describe('Settings > Plugins', () => {
  beforeEach(() => {
    stubMatchMedia()
    list = {
      disabled_all: false,
      plugins: [
        pluginOut(),
        pluginOut({ id: 'artem.today-board', name: 'Today board', status: 'needs_review', enabled: false, made_by_assistant: true, source: { kind: 'assistant', label: 'chat', conversation_ids: ['c1'] } }),
        pluginOut({ id: 'artem.sync', name: 'Sync', update_pending: true }),
        pluginOut({ id: 'artem.broken', name: 'Broken', status: 'error', error: 'Files changed', enabled: false }),
      ],
    }
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows a card per plugin with its badges', async () => {
    mockApi({ 'GET /api/plugins': () => list })
    show()
    const grid = await screen.findByRole('list', { name: 'Installed plugins' })
    const cards = within(grid).getAllByRole('article')
    expect(cards).toHaveLength(4)
    expect(within(cards[0]).getByText('Word count')).toBeInTheDocument()
    expect(within(cards[0]).getByText('1.0.0')).toBeInTheDocument()
    expect(within(cards[1]).getByText('Needs review')).toBeInTheDocument()
    expect(within(cards[1]).getByText('Made by the assistant')).toBeInTheDocument()
    expect(within(cards[2]).getByText('Update needs approval')).toBeInTheDocument()
    expect(within(cards[3]).getByText('Error')).toBeInTheDocument()
    // A plugin without an approved version can't be switched on.
    expect(within(cards[1]).getByRole('switch')).toBeDisabled()
  })

  it('switches a plugin off from its card without opening it', async () => {
    const patch = vi.fn((r: { body: unknown }) => {
      list = { ...list, plugins: list.plugins.map((p, i) => (i === 0 ? { ...p, ...(r.body as object), status: 'disabled' as const } : p)) }
      return list.plugins[0]
    })
    mockApi({ 'GET /api/plugins': () => list, 'PATCH /api/plugins/anemo.word-count': patch, 'GET /api/plugins/anemo.word-count': () => detailOut() })
    show()
    const toggle = await screen.findByRole('switch', { name: 'Use Word count' })
    await userEvent.click(toggle)
    await waitFor(() => expect(patch).toHaveBeenCalledWith(expect.objectContaining({ body: { enabled: false } })))
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByText('Detail page')).toBeNull()
  })

  it('opens the plugin’s page when the card is clicked', async () => {
    mockApi({ 'GET /api/plugins': () => list, 'GET /api/plugins/anemo.word-count': () => detailOut() })
    show()
    await userEvent.click(await screen.findByRole('button', { name: 'Open Word count' }))
    expect(await screen.findByText('Detail page')).toBeInTheDocument()
  })

  it('turns every plugin off with the kill switch', async () => {
    const put = vi.fn(() => {
      list = { ...list, disabled_all: true }
      return { disabled_all: true }
    })
    mockApi({ 'GET /api/plugins': () => list, 'PUT /api/settings/plugins': put })
    show()
    await userEvent.click(await screen.findByRole('switch', { name: 'Turn off all plugins' }))
    await waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({ body: { disabled_all: true } })))
    expect(screen.getByText('Every plugin is stopped. Turn this off to bring back the ones that were on.')).toBeInTheDocument()
  })

  it('offers the bundled examples when nothing is installed, and reviews what it installs', async () => {
    const installed = detailOut({
      status: 'needs_review', enabled: false, approved_version: null, pending_version: '1.0.0',
      versions: [versionOut({ status: 'pending', approved_at: null })],
    })
    mockApi({
      'GET /api/plugins': () => ({ plugins: [], disabled_all: false }),
      'GET /api/plugins/bundled': () => ({ plugins: [{ id: 'anemo.word-count', name: 'Word count', description: 'Counts words', version: '1.0.0', installed: false, permissions: [permission('documents:read', 'low')] }] }),
      'POST /api/plugins/install/bundled': () => installed,
    })
    show()
    expect(await screen.findByText('No plugins yet')).toBeInTheDocument()
    const example = (await screen.findByText('Counts words')).closest('li') as HTMLElement
    await userEvent.click(within(example).getByRole('button', { name: 'Install' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Review “Word count”')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Approve and enable' })).toBeInTheDocument()
  })
})
