import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { answer, detailOut, mockApi, permission, renderWithProviders, stubMatchMedia, versionOut } from '@/test/pluginFixtures'
import { InstallDialog } from './InstallDialog'

/* Installing: a zip or a Git address, then the review of the pending version with its three
 * choices. */

const pending = detailOut({
  status: 'needs_review', enabled: false, approved_version: null, pending_version: '1.0.0', made_by_assistant: false,
  versions: [versionOut({
    status: 'pending', approved_at: null, hash: 'd'.repeat(64),
    permissions: [permission('events:read', 'low'), permission('notifications:send', 'high')],
    contributions: [{ kind: 'commands', id: 'open', label: 'Open Today board', risk: 'low', detail: 'In Ctrl+K' }],
  })],
})

describe('the install dialog', () => {
  beforeEach(() => stubMatchMedia())
  afterEach(() => vi.unstubAllGlobals())

  it('uploads a zip, then reviews the pending version: permissions by risk, contributions, source', async () => {
    const upload = vi.fn(() => pending)
    const approve = vi.fn(() => detailOut())
    mockApi({ 'POST /api/plugins/install/zip': upload, 'POST /api/plugins/anemo.word-count/versions/1.0.0/approve': approve })
    const onClose = vi.fn()
    renderWithProviders(<InstallDialog onClose={onClose} onOpen={() => {}} />)
    const file = new File(['zip'], 'word-count.zip', { type: 'application/zip' })
    await userEvent.upload(screen.getByLabelText('Choose a .zip file'), file)
    await waitFor(() => expect(upload).toHaveBeenCalled())

    const dialog = await screen.findByRole('dialog', { name: 'Review “Word count”' })
    expect(within(dialog).getByRole('region', { name: 'Read-only' })).toHaveTextContent('Read your calendar')
    expect(within(dialog).getByRole('region', { name: 'Network, notifications, tools' })).toHaveTextContent('Send you notifications')
    expect(within(dialog).getByText('Open Today board')).toBeInTheDocument()
    expect(within(dialog).getByText('An example that comes with Anemo')).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve, keep off' }))
    await waitFor(() => expect(approve).toHaveBeenCalledWith(expect.objectContaining({ body: { hash: 'd'.repeat(64), enable: false } })))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('leaves the plugin waiting for review with “Not now”', async () => {
    const approve = vi.fn()
    mockApi({ 'POST /api/plugins/install/git': () => pending, 'POST /api/plugins/anemo.word-count/versions/1.0.0/approve': approve })
    const onClose = vi.fn()
    renderWithProviders(<InstallDialog onClose={onClose} onOpen={() => {}} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Git address' }))
    await userEvent.type(screen.getByLabelText(/Repository address/), 'https://github.com/a/b')
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(onClose).toHaveBeenCalled()
    expect(approve).not.toHaveBeenCalled()
  })

  it('lists the problems of a package that breaks the rules', async () => {
    mockApi({
      'POST /api/plugins/install/zip': () => answer(422, 'plugin_invalid', 'The package is not valid.', { errors: [{ path: 'ui/evil.svg', message: 'SVG files are not allowed.' }] }),
    })
    renderWithProviders(<InstallDialog onClose={() => {}} onOpen={() => {}} />)
    await userEvent.upload(screen.getByLabelText('Choose a .zip file'), new File(['x'], 'bad.zip'))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The package is not valid.')
    expect(alert).toHaveTextContent('ui/evil.svg: SVG files are not allowed.')
  })
})
