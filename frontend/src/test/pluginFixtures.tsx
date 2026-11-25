/**
 * Test helpers for the plugins feature: example data shaped like the plugins API
 * (contract §7), a fake `fetch` that answers by method and path, and a render with the
 * query client and a router.
 */
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router'
import { vi } from 'vitest'
import type { PermissionOut, PluginContributionsOut, PluginDetailOut, PluginOut, PluginVersionOut } from '@/features/plugins/types'

export const pluginOut = (over: Partial<PluginOut> = {}): PluginOut => ({
  id: 'anemo.word-count',
  name: 'Word count',
  description: 'Words, characters and reading time for the document you have open.',
  version: '1.0.0',
  icon_url: null,
  enabled: true,
  status: 'enabled',
  update_pending: false,
  made_by_assistant: false,
  error: null,
  source: { kind: 'bundled', label: 'Anemo', conversation_ids: [] },
  ui_count: 1,
  updated_at: '2026-11-20T10:00:00Z',
  ...over,
})

export const permission = (name: string, risk: PermissionOut['risk'], over: Partial<PermissionOut> = {}): PermissionOut => {
  const [kind, target] = name.startsWith('network:') || name.startsWith('tools:') ? name.split(/:(.*)/s) : [name, null]
  return { name, kind, target: target ?? null, risk, label: `Server label of ${name}`, explanation: `Server text of ${name}`, ...over }
}

export const versionOut = (over: Partial<PluginVersionOut> = {}): PluginVersionOut => ({
  version: '1.0.0',
  status: 'approved',
  hash: 'a'.repeat(64),
  created_at: '2026-11-20T10:00:00Z',
  created_by: { ref: 'user', kind: 'user', label: 'You', url: null },
  approved_at: '2026-11-20T10:05:00Z',
  manifest: {
    manifestVersion: 1,
    id: 'anemo.word-count',
    version: '1.0.0',
    name: 'Word count',
    description: 'Words',
    permissions: ['documents:read'],
    contributes: { ui: [{ id: 'panel', slot: 'object.panel', objects: ['document'], title: 'Word count', entry: 'ui/panel.html' }] },
  },
  permissions: [permission('documents:read', 'low')],
  contributions: [{ kind: 'ui', id: 'panel', label: 'Adds a panel to documents', risk: 'low', detail: '' }],
  files: [{ path: 'anemo-plugin.json', size: 400, sha256: 'b'.repeat(64) }],
  ...over,
})

export const detailOut = (over: Partial<PluginDetailOut> = {}): PluginDetailOut => ({
  ...pluginOut(),
  readme: '# Word count\n\nCounts words.',
  author: { name: 'Anemo' },
  license: 'MIT',
  approved_version: '1.0.0',
  pending_version: null,
  versions: [versionOut()],
  chats: [],
  ...over,
})

export const contributionsOut = (over: Partial<PluginContributionsOut> = {}): PluginContributionsOut => ({
  ui: [],
  commands: [],
  fences: [],
  disabled_all: false,
  ...over,
})

type Handler = (request: { method: string; path: string; search: string; body: unknown }) => unknown

/**
 * Replace `fetch` with answers by "METHOD /path" (the query string is passed along).
 * A handler may return `{ status, body }` via `answer(...)` for errors; anything else is
 * sent as a 200 JSON body. Unknown routes answer 404.
 */
export function mockApi(routes: Record<string, Handler>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    const handler = routes[`${method} ${url.pathname}`]
    if (!handler) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), { status: 404 })
    let body: unknown = undefined
    if (typeof init?.body === 'string') body = JSON.parse(init.body)
    const result = await handler({ method, path: url.pathname, search: url.search, body })
    if (result instanceof Response) return result
    if (result === undefined) return new Response(null, { status: 204 })
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

/** An error answer for mockApi. */
export const answer = (status: number, code: string, message = code, details?: unknown) =>
  new Response(JSON.stringify({ error: { code, message, details } }), { status, headers: { 'Content-Type': 'application/json' } })

/** jsdom has no matchMedia; the app asks it for the phone layout and reduced motion. */
export function stubMatchMedia(matches: (query: string) => boolean = (q) => q.includes('min-width')) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matches(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }))
}

/** Render routes at an address, with a fresh query client (no retries). */
export function renderRoutes(routes: RouteObject[], at: string, seed?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  seed?.(client)
  const router = createMemoryRouter(routes, { initialEntries: [at] })
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { ...view, router, client }
}

/** Render one element at "/" with the providers. */
export const renderWithProviders = (element: ReactElement, at = '/') => renderRoutes([{ path: '*', element }], at)
