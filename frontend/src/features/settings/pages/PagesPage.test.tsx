import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocaleForTest } from '@/lib/i18n'

const puts = vi.hoisted(() => ({ calls: [] as { path: string; body: unknown }[] }))

vi.mock('@/api/client', () => ({
  api: {
    GET: async () => ({ data: undefined }),
    PUT: async (path: string, init: { body: unknown }) => { puts.calls.push({ path, body: init.body }); return { data: init.body } },
  },
  unwrap: (r: { data: unknown }) => r.data,
  errorMessage: (e: unknown) => String(e),
}))

const { PagesPage } = await import('./PagesPage')
const { DEFAULT_NAVIGATION } = await import('../navigation')

function show(navigation: unknown = DEFAULT_NAVIGATION) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  qc.setQueryData(['settings'], { navigation })
  render(<QueryClientProvider client={qc}><PagesPage /></QueryClientProvider>)
}
const names = (region: string) => within(screen.getByRole('region', { name: region })).queryAllByRole('listitem').map((li) => li.querySelector('[data-page-name]')?.textContent)

beforeEach(() => {
  puts.calls.length = 0
  // What Radix Select needs from a browser and jsdom lacks.
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
})
afterEach(() => setLocaleForTest('en'))

describe('Settings > Pages', () => {
  it('lists every page where it is', () => {
    show()
    expect(names('Sidebar')).toEqual(['Home', 'Inbox', 'Tasks', 'Calendar', 'Documents', 'Files'])
    expect(names('More')).toEqual(['Projects', 'Focus', 'Music', 'Runs', 'Automations', 'Profiles & Skills', 'Memory'])
    expect(screen.getByText('Every page is on.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()
  })

  it('moves a page up and saves the new order', async () => {
    show()
    await userEvent.click(screen.getByRole('button', { name: 'Move Music up' }))
    await waitFor(() => expect(puts.calls).toHaveLength(1))
    expect(puts.calls[0].path).toBe('/api/settings/navigation')
    expect((puts.calls[0].body as typeof DEFAULT_NAVIGATION).more.slice(0, 3)).toEqual(['projects', 'music', 'focus'])
    // The first of a list cannot go further up.
    expect(screen.getByRole('button', { name: 'Move Home up' })).toBeDisabled()
  })

  it('turns a page off, and offers no “Off” for Home and the Inbox', async () => {
    show()
    await userEvent.click(screen.getByRole('combobox', { name: 'Where Music goes' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Off' }))
    await waitFor(() => expect(puts.calls).toHaveLength(1))
    expect(puts.calls[0].body).toEqual({ ...DEFAULT_NAVIGATION, more: DEFAULT_NAVIGATION.more.filter((id) => id !== 'music'), off: ['music'] })
    await waitFor(() => expect(names('Off')).toEqual(['Music']))

    await userEvent.click(screen.getByRole('combobox', { name: 'Where Inbox goes' }))
    expect(await screen.findByRole('option', { name: 'More' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Off' })).not.toBeInTheDocument()
  })

  it('goes back to the default arrangement', async () => {
    show({ pinned: ['home'], more: ['tasks'], off: ['music'] })
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(puts.calls.at(-1)?.body).toEqual(DEFAULT_NAVIGATION))
  })

  it('is shown in the chosen language', () => {
    setLocaleForTest('uk', { Music: 'Музика', Sidebar: 'Бічна панель', 'Move {page} up': 'Перемістити «{page}» вище' })
    show()
    expect(screen.getByRole('region', { name: 'Бічна панель' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Перемістити «Музика» вище' })).toBeInTheDocument()
  })
})
