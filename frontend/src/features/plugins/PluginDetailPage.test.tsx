import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detailOut, mockApi, permission, pluginOut, renderRoutes, stubMatchMedia, versionOut } from '@/test/pluginFixtures'
import { pluginListKey } from './api'
import { PluginDetailPage } from './PluginDetailPage'
import type { PluginDetailOut } from './types'

/* A plugin's page: drawn at once from the list, its tabs, permissions by risk, and the
 * review of an update (approving names the version's hash). */

const routes = [
  { path: '/settings/plugins', element: <p>The list</p> },
  { path: '/settings/plugins/:pluginId', element: <PluginDetailPage /> },
  { path: '/c/:id', element: <p>A chat</p> },
]

const update: PluginDetailOut = detailOut({
  update_pending: true,
  pending_version: '1.1.0',
  versions: [
    versionOut({
      version: '1.1.0', status: 'pending', hash: 'c'.repeat(64), approved_at: null,
      permissions: [permission('documents:read', 'low'), permission('network:api.example.com', 'high'), permission('tools:shell_run', 'critical'), permission('tasks:write', 'medium')],
    }),
    versionOut(),
  ],
})

/** A data summary as the server sends it (PluginDataOut). */
const DATA = {
  resources: [
    { kind: 'properties', id: 'stage', object_type: 'property', object_id: 'p1', label: 'Stage', owned: true },
    { kind: 'properties', id: 'tags', object_type: 'property', object_id: 'p2', label: 'Tags', owned: false },
  ],
  storage_keys: 3,
  storage_bytes: 2048,
  tasks: 2,
  documents: 0,
  events: 1,
}

describe('a plugin’s page', () => {
  beforeEach(() => stubMatchMedia())
  afterEach(() => vi.unstubAllGlobals())

  it('draws the header at once from the list, before its own data arrives', async () => {
    let answer: (value: PluginDetailOut) => void = () => {}
    mockApi({
      'GET /api/plugins/anemo.word-count': () => new Promise<PluginDetailOut>((resolve) => { answer = resolve }),
      'GET /api/plugins': () => ({ plugins: [pluginOut()], disabled_all: false }),
    })
    // The list is in the cache, as when the page is opened from its card.
    const view = renderRoutes(routes, '/settings/plugins/anemo.word-count', (client) => client.setQueryData(pluginListKey, { plugins: [pluginOut()], disabled_all: false }))
    expect(await view.findByRole('heading', { name: 'Word count' })).toBeInTheDocument()
    answer(detailOut())
    expect(await view.findByText('Counts words.')).toBeInTheDocument() // the README
  })

  it('switches between its tabs', async () => {
    mockApi({
      'GET /api/plugins/anemo.word-count': () => detailOut({ source: { kind: 'git', label: 'repo', url: 'https://github.com/a/b', ref: 'main', commit: 'abc123', conversation_ids: [] } }),
      'GET /api/plugins': () => ({ plugins: [pluginOut()], disabled_all: false }),
      'GET /api/plugins/anemo.word-count/data': () => DATA,
    })
    renderRoutes(routes, '/settings/plugins/anemo.word-count')
    const tabs = await screen.findByRole('tablist', { name: 'About this plugin' })
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Permissions', 'Contributions', 'Versions', 'Source', 'Data'])
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Source' }))
    expect(screen.getByText('https://github.com/a/b')).toBeInTheDocument()
    expect(screen.getByText('abc123')).toBeInTheDocument()
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Data' }))
    const added = await screen.findByRole('region', { name: 'What it added' })
    expect(within(added).getByText('Stage')).toBeInTheDocument()
    expect(within(added).getAllByText('Properties')).toHaveLength(2)
    // Adopted (it existed before): marked, as it stays when the plugin goes.
    expect(within(added).getAllByText('Was already yours')).toHaveLength(1)
    expect(screen.getByText('Created through its calls: 2 tasks, 1 event')).toBeInTheDocument()
    expect(screen.getByText('Its own storage: 3 keys, 2 KB')).toBeInTheDocument()
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Contributions' }))
    expect(screen.getByText('Adds a panel to documents')).toBeInTheDocument()
  })

  it('says what uninstalling does with its data, for each choice', async () => {
    mockApi({
      'GET /api/plugins/anemo.word-count': () => detailOut(),
      'GET /api/plugins': () => ({ plugins: [pluginOut()], disabled_all: false }),
      'GET /api/plugins/anemo.word-count/data': () => DATA,
    })
    renderRoutes(routes, '/settings/plugins/anemo.word-count')
    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Deleted: Stage (Properties)')).toBeInTheDocument()
    expect(within(dialog).getByText('To the Trash: 2 tasks, 1 event')).toBeInTheDocument()
    expect(within(dialog).getByText('Its storage: 2 KB')).toBeInTheDocument()
    expect(within(dialog).getByText('Stays, as it was yours before: Tags (Properties)')).toBeInTheDocument()
  })

  it('groups permissions by risk, in the app’s own words, with the warning about reading', async () => {
    mockApi({
      'GET /api/plugins/anemo.word-count': () => detailOut({
        versions: [versionOut({ permissions: [permission('tools:shell_run', 'critical'), permission('documents:read', 'low'), permission('network:*.example.com', 'high'), permission('tasks:write', 'medium')] })],
      }),
      'GET /api/plugins': () => ({ plugins: [pluginOut()], disabled_all: false }),
    })
    renderRoutes(routes, '/settings/plugins/anemo.word-count?tab=permissions')
    await screen.findByText('Read your documents')
    const groups = screen.getAllByRole('region').filter((r) => r.getAttribute('aria-label') !== 'Word count')
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Read-only', 'Writes your data', 'Network, notifications, tools', 'Devices, shell, computer: asks every time'])
    expect(within(groups[0]).getByText('Read your documents')).toBeInTheDocument()
    expect(within(groups[2]).getByText('Reach any address under example.com')).toBeInTheDocument()
    expect(within(groups[3]).getByText('Use the tool shell_run')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('What a plugin can read, a malicious plugin could send out.')
  })

  it('reviews an update: added permissions, the files’ diff, and approval with the version’s hash', async () => {
    const approve = vi.fn(() => detailOut())
    mockApi({
      'GET /api/plugins/anemo.word-count': () => update,
      'GET /api/plugins': () => ({ plugins: [pluginOut({ update_pending: true })], disabled_all: false }),
      'GET /api/plugins/anemo.word-count/versions/1.1.0/diff': () => ({
        from: '1.0.0', to: '1.1.0',
        manifest: { before: { version: '1.0.0' }, after: { version: '1.1.0' } },
        permissions: { added: [permission('network:api.example.com', 'high')], removed: [], kept: [permission('documents:read', 'low')] },
        files: [{ path: 'ui/panel.js', status: 'changed', before: 'count()', after: 'count()\nsend()' }],
      }),
      'POST /api/plugins/anemo.word-count/versions/1.1.0/approve': approve,
    })
    renderRoutes(routes, '/settings/plugins/anemo.word-count')
    await userEvent.click(await screen.findByRole('button', { name: 'Review update' }))
    expect(await screen.findByText('Version 1.1.0 is waiting for you')).toBeInTheDocument()
    expect(await screen.findByText('Reach api.example.com')).toBeInTheDocument()
    expect(screen.getByText('New')).toBeInTheDocument()
    expect(screen.getByLabelText('ui/panel.js')).toHaveTextContent('send()')
    await userEvent.click(screen.getByRole('button', { name: 'Approve and enable' }))
    await waitFor(() => expect(approve).toHaveBeenCalledWith(expect.objectContaining({ body: { hash: 'c'.repeat(64), enable: true } })))
  })

  it('continues building with the assistant in a chat linked to the plugin', async () => {
    mockApi({
      'GET /api/plugins/anemo.word-count': () => detailOut(),
      'GET /api/plugins': () => ({ plugins: [pluginOut()], disabled_all: false }),
      'POST /api/plugins/anemo.word-count/chat': () => ({ conversation_id: 'c9' }),
    })
    const { router } = renderRoutes(routes, '/settings/plugins/anemo.word-count')
    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Continue building with the assistant' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/c/c9'))
  })
})
