/**
 * Every request of the plugins feature: the queries and mutations of Settings > Plugins,
 * the slots' contributions and the host's calls (contract §7). JSON goes through the typed
 * `api` client; only the zip upload uses `fetch` (multipart), answered through the same
 * `unwrap()` (same ApiError, same "signed out" handling). Nothing outside this file sends
 * a request.
 */
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, unwrap } from '@/api/client'
import { useSaveSection } from '@/features/settings/api'
import { withReauth } from '@/features/auth/reauthStore'
import { t } from '@/lib/i18n'
import type {
  PluginCallBody,
  PluginContributionsOut,
  PluginDetailOut,
  PluginListOut,
  PluginOut,
} from './types'

/** Every plugins query starts with this, so one invalidation refreshes them all. */
export const pluginsKey = ['plugins'] as const
export const pluginListKey = [...pluginsKey, 'list'] as const
export const pluginKey = (id: string) => [...pluginsKey, 'detail', id] as const
export const contributionsKey = [...pluginsKey, 'contributions'] as const
export const bundledKey = [...pluginsKey, 'bundled'] as const

/** A multipart upload (the zip); errors as ApiError, like the typed client's. */
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
    queryFn: async () => unwrap(await api.GET('/api/plugins')),
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
    author: { name: '' },
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

const fetchDetail = async (id: string) => unwrap(await api.GET('/api/plugins/{plugin}', { params: { path: { plugin: id } } }))

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
    queryFn: async () => unwrap(await api.GET('/api/plugins/bundled')).plugins,
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
    queryFn: async () => unwrap(await api.GET('/api/plugins/contributions')),
    staleTime: 60_000,
  })
}

export function usePluginDiff(id: string, version: string | null, against?: string | null) {
  return useQuery({
    queryKey: [...pluginsKey, 'diff', id, version, against ?? null],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/plugins/{plugin}/versions/{version}/diff', {
          params: { path: { plugin: id, version: version ?? '' }, query: against ? { against } : {} },
        }),
      ),
    enabled: version !== null,
    staleTime: Infinity, // a version's files never change
  })
}

export function usePluginData(id: string, enabled = true) {
  return useQuery({
    queryKey: [...pluginsKey, 'data', id],
    queryFn: async () => unwrap(await api.GET('/api/plugins/{plugin}/data', { params: { path: { plugin: id } } })),
    enabled,
  })
}

/** The files a frame is built from. A version never changes, so it is fetched once. */
export function fetchFrameBundle(qc: QueryClient, id: string, version: string, ui: string) {
  return qc.fetchQuery({
    queryKey: [...pluginsKey, 'bundle', id, version, ui],
    queryFn: async () =>
      unwrap(await api.GET('/api/plugins/{plugin}/versions/{version}/ui/{ui}', { params: { path: { plugin: id, version, ui } } })),
    staleTime: Infinity,
  })
}

/**
 * One call of a plugin, carried out by the server (contract §6.4). Errors as ApiError:
 * 409 `confirm_required` (details `{token, summary, risk}`), 403 `permission_denied` or
 * `declined`, 404 `not_found`/`unknown_method`, 400 `invalid_params`, 429 `rate_limited`,
 * 503 `unavailable`, 422 `failed`.
 */
export async function callPlugin(id: string, body: PluginCallBody): Promise<unknown> {
  const answer = unwrap(await api.POST('/api/plugins/{plugin}/call', { params: { path: { plugin: id } }, body }))
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
    mutationFn: async (v: { id: string; enabled: boolean }) =>
      unwrap(await api.PATCH('/api/plugins/{plugin}', { params: { path: { plugin: v.id } }, body: { enabled: v.enabled } })),
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
      withReauth(async () =>
        unwrap(
          await api.POST('/api/plugins/{plugin}/versions/{version}/approve', {
            params: { path: { plugin: v.id, version: v.version } },
            body: { hash: v.hash, enable: v.enable },
          }),
        ),
      ),
    onSuccess: keep,
  })
}

/** Reject (discard) a pending version. */
export function useRejectVersion() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (v: { id: string; version: string }) =>
      unwrap(await api.DELETE('/api/plugins/{plugin}/versions/{version}', { params: { path: { plugin: v.id, version: v.version } } })),
    onSuccess: refresh,
  })
}

export function useUninstallPlugin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; data: 'keep' | 'remove' }) =>
      unwrap(await api.DELETE('/api/plugins/{plugin}', { params: { path: { plugin: v.id }, query: { data: v.data } } })),
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
      withReauth(async (): Promise<PluginDetailOut> => {
        if (v.kind === 'zip') {
          const form = new FormData()
          form.append('file', v.file)
          return upload<PluginDetailOut>('/api/plugins/install/zip', form)
        }
        if (v.kind === 'git') return unwrap(await api.POST('/api/plugins/install/git', { body: { url: v.url, ref: v.ref || null } }))
        return unwrap(await api.POST('/api/plugins/install/bundled', { body: { id: v.id } }))
      }),
    onSuccess: keep,
  })
}

/** "Continue building with the assistant": a chat linked to the plugin (201 `{conversation_id}`). */
export function useStartPluginChat() {
  return useMutation({
    mutationFn: async (id: string) => unwrap(await api.POST('/api/plugins/{plugin}/chat', { params: { path: { plugin: id } } })),
  })
}

/**
 * The kill switch: the `plugins` settings section, `{disabled_all}` (not sensitive, so
 * switching everything off is one click). Saved like any settings section; the list and
 * the slots show it at once too.
 */
export function useSetPluginsKillSwitch() {
  const qc = useQueryClient()
  const save = useSaveSection('plugins')
  const show = (off: boolean) => {
    qc.setQueryData<PluginListOut>(pluginListKey, (old) => old && { ...old, disabled_all: off })
    qc.setQueryData<PluginContributionsOut>(contributionsKey, (old) => old && { ...old, disabled_all: off })
  }
  return {
    isPending: save.isPending,
    isError: save.isError,
    error: save.error,
    mutate: (off: boolean) => {
      const before = qc.getQueryData<PluginListOut>(pluginListKey)?.disabled_all
      show(off)
      save.mutate(
        { disabled_all: off },
        {
          onError: () => {
            if (before !== undefined) show(before)
          },
          onSettled: () => void qc.invalidateQueries({ queryKey: pluginsKey }),
        },
      )
    },
  }
}
