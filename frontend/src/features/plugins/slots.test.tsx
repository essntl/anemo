import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentInfo } from '@/features/documents/components/DocumentInfo'
import { fenceRenderer } from '@/lib/fenceRenderers'
import { contributionsOut, mockApi, renderWithProviders, stubMatchMedia } from '@/test/pluginFixtures'
import { PluginFences, PluginLinks, PluginPanels } from './slots'
import type { ContributionUi } from './types'

/* Where plugins show up: panels on objects, a tab beside a document, the sidebar group and
 * chat fences; and nowhere with the kill switch on. */

const ui = (over: Partial<ContributionUi>): ContributionUi => ({
  plugin_id: 'anemo.word-count', plugin_name: 'Word count', icon_url: null, version: '1.0.0', permissions: ['documents:read'],
  id: 'panel', slot: 'object.panel', title: 'Words', icon: null, objects: ['document', 'task'], fence: null, height: 120, ...over,
})

const contributions = contributionsOut({
  ui: [ui({}), ui({ id: 'today', slot: 'page', title: 'Today board', objects: [] }), ui({ id: 'kanban', slot: 'chat.block', fence: 'today-kanban', objects: [] })],
  fences: [{ plugin_id: 'anemo.word-count', ui: 'kanban', fence: 'today-kanban' }],
})

describe('plugin slots', () => {
  beforeEach(() => {
    stubMatchMedia()
    localStorage.clear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows a plugin panel on a task, with the object as its context', async () => {
    mockApi({ 'GET /api/plugins/contributions': () => contributions })
    renderWithProviders(<PluginPanels type="task" id="t1" />)
    expect(await screen.findByRole('region', { name: 'Words' })).toBeInTheDocument()
    expect(screen.getByTitle('Words').tagName).toBe('IFRAME')
  })

  it('shows nothing with the kill switch on', async () => {
    const fetch = mockApi({ 'GET /api/plugins/contributions': () => ({ ...contributions, disabled_all: true }) })
    renderWithProviders(<><PluginPanels type="task" id="t1" /><PluginLinks /></>)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('lists plugin pages in their own sidebar group', async () => {
    mockApi({ 'GET /api/plugins/contributions': () => contributions })
    renderWithProviders(<PluginLinks />)
    const link = await screen.findByRole('link', { name: 'Today board' })
    expect(link).toHaveAttribute('href', '/plugins/anemo.word-count/today')
    expect(screen.getByRole('navigation', { name: 'Plugins' })).toBeInTheDocument()
  })

  it('registers the fences of enabled plugins for chat answers', async () => {
    mockApi({ 'GET /api/plugins/contributions': () => contributions })
    const view = renderWithProviders(<PluginFences />)
    await waitFor(() => expect(fenceRenderer('today-kanban')).toBeDefined())
    view.unmount()
    expect(fenceRenderer('today-kanban')).toBeUndefined()
  })

  it('adds a tab beside a document, and remembers it', async () => {
    mockApi({
      'GET /api/plugins/contributions': () => contributions,
      'GET /api/documents': () => ({ documents: [] }),
    })
    const show = () => renderWithProviders(
      <DocumentInfo documentId="d1" path="notes/a.md" words={10} outline={[]} active={-1} onJump={() => {}} onHistory={() => {}} chat={<p>chat</p>} />,
    )
    const view = show()
    const tab = await screen.findByRole('tab', { name: 'Words' })
    await userEvent.click(tab)
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(localStorage.getItem('anemo.docPanelTab')).toBe('plugin:anemo.word-count/panel')
    expect(document.querySelector('iframe')).toHaveAttribute('title', 'Words')
    view.unmount()
    // Opened again: the plugin's tab is chosen once the plugins are known.
    show()
    expect(await screen.findByRole('tab', { name: 'Words' })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the outline when the remembered plugin tab is gone', async () => {
    localStorage.setItem('anemo.docPanelTab', 'plugin:gone.plugin/panel')
    mockApi({ 'GET /api/plugins/contributions': () => contributionsOut() })
    renderWithProviders(
      <DocumentInfo documentId="d1" path="notes/a.md" words={10} outline={[]} active={-1} onJump={() => {}} onHistory={() => {}} chat={<p>chat</p>} />,
    )
    expect(await screen.findByRole('tab', { name: 'Outline' })).toHaveAttribute('aria-selected', 'true')
  })
})
