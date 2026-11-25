/**
 * Every request of the plugins feature: the queries and mutations of Settings > Plugins,
 * the slots' contributions and the host's calls (contract §7).
 *
 * The plugins API is being built in parallel (workstream A), so the generated client
 * doesn't know these routes yet: `request()` below sends them with `fetch` and reads the
 * answer through the same `unwrap()` as the typed client (same ApiError, same "signed
 * out" handling). Once A is merged and `make gen-api` has run, `request()` is replaced by
 * `api.GET('/api/plugins', …)` and friends; nothing outside this file sends a request.
 */
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, unwrap } from '@/api/client'
import { type AllSettings, settingsKey } from '@/features/settings/api'
import { withReauth } from '@/features/auth/reauthStore'
import { t } from '@/lib/i18n'
import type {
  BundledPluginOut,
  PluginContributionsOut,
  PluginDataOut,
  PluginDetailOut,
  PluginDiffOut,
  PluginFrameBundleOut,
  PluginListOut,
  PluginOut,
} from './types'

/** Every plugins query starts with this, so one invalidation refreshes them all. */
export const pluginsKey = ['plugins'] as const
export const pluginListKey = [...pluginsKey, 'list'] as const
export const pluginKey = (id: string) => [...pluginsKey, 'detail', id] as const
export const contributionsKey = [...pluginsKey, 'contributions'] as const
export const bundledKey = [...pluginsKey, 'bundled'] as const

const enc = encodeURIComponent

/**
 * A JSON request to the server, answered like the typed client's: the parsed body, or an
 * ApiError with the server's code. (Temporary, see the top of this file.)
 */
async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  // A 204 (or any empty answer) has no body to read.
  const text = response.status === 204 ? '' : await response.text()
  let parsed: unknown = undefined
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  return unwrap<T>(response.ok ? { data: parsed as T, response } : { error: parsed, response })
}

/** A multipart upload (the zip); errors as ApiError, like `request`. */
async function upload<T>(url: string, form: FormData): Promise<T> {
  const response = await fetch(url, { method: 'POST', body: form, credentials: 'same-origin' })
  const parsed = await response.json().catch(() => undefined)
  if (!response.ok && parsed === undefined) throw new ApiError(response.status, `http_${response.status}`, t('Upload failed'))
  return unwrap<T>(response.ok ? { data: parsed as T, response } : { error: parsed, response })
}

// ---- Queries ---------------------------------------------------------------------------

export function usePlugins() {
  return useQuery({
    queryKey: pluginListKey,
    queryFn: () => request<PluginListOut>('GET', '/api/plugins'),
  })
}

/**
 * What the detail page shows before its own request has answered: the card's data from
 * the list, with the detail-only fields empty. The page (and the card → page transition)
 * can then draw the header at once, with no flash of a loading state.
 */
export function detailFromListItem(item: PluginOut): PluginDetailOut {
  return {
    ...item,
    readme: null,
    author: null,
    license: null,
    approved_version: null,
    pending_version: null,
    versions: [],
    chats: [],
  }
}

function listItem(qc: QueryClient, id: string): PluginOut | undefined {
  return qc.getQueryData<PluginListOut>(pluginListKey)?.plugins.find((p) => p.id === id)
}

const fetchDetail = (id: string) => request<PluginDetailOut>('GET', `/api/plugins/${enc(id)}`)

export function usePlugin(id: string) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: pluginKey(id),
    queryFn: () => fetchDetail(id),
    // Seeded from the list (not cached as the real thing: isPlaceholderData tells them apart).
    placeholderData: () => {
      const item = listItem(qc, id)
      return item ? detailFromListItem(item) : undefined
    },
  })
}

/** Start loading a plugin's page before it is opened (pointer over its card, a click). */
export function prefetchPlugin(qc: QueryClient, id: string): void {
  void qc.prefetchQuery({ queryKey: pluginKey(id), queryFn: () => fetchDetail(id), staleTime: 10_000 })
}

export function useBundledPlugins(enabled = true) {
  return useQuery({
    queryKey: bundledKey,
    queryFn: async () => (await request<{ plugins: BundledPluginOut[] }>('GET', '/api/plugins/bundled')).plugins,
    enabled,
    staleTime: 5 * 60_000,
  })
}

/**
 * What the slots draw: the UI, commands and chat fences of every enabled, approved
 * plugin. One request for the whole app, kept for a minute; every change to a plugin
 * refreshes it (it is under `pluginsKey`).
 */
export function usePluginContributions() {
  return useQuery({
    queryKey: contributionsKey,
    queryFn: () => request<PluginContributionsOut>('GET', '/api/plugins/contributions'),
    staleTime: 60_000,
  })
}

export function usePluginDiff(id: string, version: string | null, against?: string | null) {
  return useQuery({
    queryKey: [...pluginsKey, 'diff', id, version, against ?? null],
    queryFn: () => {
      const query = against ? `?against=${enc(against)}` : ''
      return request<PluginDiffOut>('GET', `/api/plugins/${enc(id)}/versions/${enc(version ?? '')}/diff${query}`)
    },
    enabled: version !== null,
    staleTime: Infinity, // a version's files never change
  })
}

export function usePluginData(id: string, enabled = true) {
  return useQuery({
    queryKey: [...pluginsKey, 'data', id],
    queryFn: () => request<PluginDataOut>('GET', `/api/plugins/${enc(id)}/data`),
    enabled,
  })
}

/** The files a frame is built from. A version never changes, so it is fetched once. */
export function fetchFrameBundle(qc: QueryClient, id: string, version: string, ui: string): Promise<PluginFrameBundleOut> {
  return qc.fetchQuery({
    queryKey: [...pluginsKey, 'bundle', id, version, ui],
    queryFn: () => request<PluginFrameBundleOut>('GET', `/api/plugins/${enc(id)}/versions/${enc(version)}/ui/${enc(ui)}`),
    staleTime: Infinity,
  })
}

/** The body of a plugin call (contract §7). `ui` is null for a command from Ctrl+K. */
export interface PluginCallBody {
  ui: string | null
  method: string
  params: unknown
  confirm_token?: string
  preview_version?: string
}

/** One call of a plugin, carried out by the server (contract §6.4). Errors as ApiError. */
export async function callPlugin(id: string, body: PluginCallBody): Promise<unknown> {
  const answer = await request<{ result?: unknown }>('POST', `/api/plugins/${enc(id)}/call`, body)
  return answer?.result ?? null
}

// ---- Mutations -------------------------------------------------------------------------

function useRefresh() {
  const qc = useQueryClient()
  return () => void qc.invalidateQueries({ queryKey: pluginsKey })
}

/** Keep the answer of a change as the plugin's detail, so its page shows it at once. */
function useKeepDetail() {
  const qc = useQueryClient()
  return (detail: PluginDetailOut) => {
    qc.setQueryData(pluginKey(detail.id), detail)
    void qc.invalidateQueries({ queryKey: pluginsKey })
  }
}

/** Switch a plugin on or off. The card's switch moves at once; a refusal puts it back. */
export function useSetPluginEnabled() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => request<PluginOut>('PATCH', `/api/plugins/${enc(v.id)}`, { enabled: v.enabled }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: pluginListKey })
      const before = qc.getQueryData<PluginListOut>(pluginListKey)
      const patch = (p: PluginOut): PluginOut => ({ ...p, enabled: v.enabled, status: p.status === 'error' || p.status === 'needs_review' ? p.status : v.enabled ? 'enabled' : 'disabled' })
      qc.setQueryData<PluginListOut>(pluginListKey, (old) => old && { ...old, plugins: old.plugins.map((p) => (p.id === v.id ? patch(p) : p)) })
      qc.setQueryData<PluginDetailOut>(pluginKey(v.id), (old) => old && { ...old, ...patch(old) })
      return { before }
    },
    onError: (_err, _v, context) => {
      if (context?.before) qc.setQueryData(pluginListKey, context.before)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: pluginsKey }),
  })
}

/** Approve a version (needs the password). `hash` is the version the user reviewed. */
export function useApproveVersion() {
  const keep = useKeepDetail()
  return useMutation({
    mutationFn: (v: { id: string; version: string; hash: string; enable: boolean }) =>
      withReauth(() =>
        request<PluginDetailOut>('POST', `/api/plugins/${enc(v.id)}/versions/${enc(v.version)}/approve`, { hash: v.hash, enable: v.enable }),
      ),
    onSuccess: keep,
  })
}

/** Reject (discard) a pending version. */
export function useRejectVersion() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (v: { id: string; version: string }) => request<void>('DELETE', `/api/plugins/${enc(v.id)}/versions/${enc(v.version)}`),
    onSuccess: refresh,
  })
}

export function useUninstallPlugin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string; data: 'keep' | 'remove' }) => request<void>('DELETE', `/api/plugins/${enc(v.id)}?data=${v.data}`),
    onSuccess: (_answer, v) => {
      qc.setQueryData<PluginListOut>(pluginListKey, (old) => old && { ...old, plugins: old.plugins.filter((p) => p.id !== v.id) })
      qc.removeQueries({ queryKey: pluginKey(v.id) })
      void qc.invalidateQueries({ queryKey: pluginsKey })
    },
  })
}

export type InstallRequest = { kind: 'zip'; file: File } | { kind: 'git'; url: string; ref?: string } | { kind: 'bundled'; id: string }

/** Install a plugin, or a new version of one (needs the password). Answers with its detail. */
export function useInstallPlugin() {
  const keep = useKeepDetail()
  return useMutation({
    mutationFn: (v: InstallRequest) =>
      withReauth(() => {
        if (v.kind === 'zip') {
          const form = new FormData()
          form.append('file', v.file)
          return upload<PluginDetailOut>('/api/plugins/install/zip', form)
        }
        if (v.kind === 'git') return request<PluginDetailOut>('POST', '/api/plugins/install/git', { url: v.url, ref: v.ref || null })
        return request<PluginDetailOut>('POST', '/api/plugins/install/bundled', { id: v.id })
      }),
    onSuccess: keep,
  })
}

/** "Continue building with the assistant": a chat linked to the plugin. */
export function useStartPluginChat() {
  return useMutation({
    mutationFn: (id: string) => request<{ conversation_id: string }>('POST', `/api/plugins/${enc(id)}/chat`),
  })
}

/**
 * The kill switch: the `plugins` settings section, `{disabled_all}` (not sensitive, so
 * switching everything off is one click). Shown at once in the list and the slots.
 */
export function useSetPluginsKillSwitch() {
  const qc = useQueryClient()
  const set = (off: boolean) => {
    qc.setQueryData<PluginListOut>(pluginListKey, (old) => old && { ...old, disabled_all: off })
    qc.setQueryData<PluginContributionsOut>(contributionsKey, (old) => old && { ...old, disabled_all: off })
  }
  return useMutation({
    mutationFn: (off: boolean) => request<{ disabled_all: boolean }>('PUT', '/api/settings/plugins', { disabled_all: off }),
    onMutate: (off) => {
      const before = qc.getQueryData<PluginListOut>(pluginListKey)?.disabled_all
      set(off)
      return { before }
    },
    onError: (_err, _off, context) => {
      if (context?.before !== undefined) set(context.before)
    },
    onSuccess: (section) => {
      // The section isn't in the generated settings types yet (workstream A adds it).
      qc.setQueryData<AllSettings>(settingsKey, (old) => (old ? ({ ...old, plugins: section } as AllSettings) : old))
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: pluginsKey }),
  })
}
