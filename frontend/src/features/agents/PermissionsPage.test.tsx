import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLocaleForTest } from '@/lib/i18n'
import ru from '@/locales/ru'
import uk from '@/locales/uk'

vi.mock('@/api/client', () => ({
  api: { GET: async () => ({ data: undefined }), POST: async () => ({ data: undefined }) },
  unwrap: (r: { data: unknown }) => r.data,
  errorMessage: (e: unknown) => String(e),
}))

const { PermissionsPage } = await import('./PermissionsPage')

// What the server sends for "Read earlier chats" (backend/app/policy/presets.py).
const CHATS = {
  capability: 'chats.read',
  label: 'Read earlier chats',
  description: 'Search your earlier chats and read them (never the chat the agent is in, nor temporary chats). Automations only when their tool list names these tools.',
  default_level: 'autonomous',
  workspace_scoped: false,
}

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  qc.setQueryData(['settings'], { permissions: { levels: {}, ceiling: {}, extra_rules: [], limits: {}, plan_review: 'off' } })
  qc.setQueryData(['permissions', 'catalog'], {
    categories: [CHATS],
    levels: [{ level: 'deny', label: 'Never' }, { level: 'autonomous', label: 'Fully autonomous' }],
  })
  render(<QueryClientProvider client={qc}><PermissionsPage /></QueryClientProvider>)
}

afterEach(() => setLocaleForTest('en'))

describe('Settings > Agent Permissions', () => {
  it('lists “Read earlier chats” at its default level', () => {
    show()
    // In the levels card (and again in the ceiling card).
    expect(screen.getAllByText('Read earlier chats').length).toBeGreaterThan(0)
    expect(screen.getByText(CHATS.description)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Read earlier chats level' })).toHaveTextContent('Fully autonomous')
  })

  it.each([['uk', uk], ['ru', ru]] as const)('shows it in %s', (locale, messages) => {
    setLocaleForTest(locale, messages)
    show()
    expect(screen.getAllByText(messages[CHATS.label]).length).toBeGreaterThan(0)
    expect(screen.getByText(messages[CHATS.description])).toBeInTheDocument()
  })
})
