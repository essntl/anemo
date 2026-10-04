import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type Schemas, unwrap } from '@/api/client'

export type Entry = Schemas['EntryOut']
export type TrashItem = Schemas['TrashItemOut']

const filesKey = ['files'] as const
export const folderKey = (path: string) => ['files', 'folder', path] as const
export const contentKey = (path: string) => ['files', 'content', path] as const

export function useFolder(path: string) {
  return useQuery({
    queryKey: folderKey(path),
    queryFn: async () => unwrap(await api.GET('/api/files', { params: { query: { path } } })),
  })
}

export function useFileSearch(q: string) {
  return useQuery({
    queryKey: ['files', 'search', q],
    enabled: q.length > 0,
    queryFn: async () => unwrap(await api.GET('/api/files/search', { params: { query: { q } } })),
  })
}

export function useFileContent(path: string | null) {
  return useQuery({
    queryKey: contentKey(path ?? ''),
    enabled: Boolean(path),
    retry: false,
    staleTime: 0,
    queryFn: async () => unwrap(await api.GET('/api/files/content', { params: { query: { path: path! } } })),
  })
}

export function useTrash(enabled: boolean) {
  return useQuery({
    queryKey: ['files', 'trash'],
    enabled,
    queryFn: async () => unwrap(await api.GET('/api/files/trash')),
  })
}

/** Refresh every file view after a change (listings, search, trash). */
function useRefresh() {
  const qc = useQueryClient()
  return () => void qc.invalidateQueries({ queryKey: filesKey })
}

export function useSaveFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: { path: string; content: string; base_hash: string | null }) =>
      unwrap(await api.PUT('/api/files/content', { body })),
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ['files', 'folder'] })
      void qc.invalidateQueries({ queryKey: contentKey(saved.path) })
    },
  })
}

export function useMakeFolder() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (path: string) => unwrap(await api.POST('/api/files/folder', { body: { path } })),
    onSuccess: refresh,
  })
}

type MoveBody = { source: string; destination: string; /** add " (1)" if the name is taken */ keep_both?: boolean }

export function useMove() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async ({ keep_both = false, ...body }: MoveBody) =>
      unwrap(await api.POST('/api/files/move', { body: { ...body, keep_both } })),
    onSuccess: refresh,
  })
}

export function useCopy() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async ({ keep_both = false, ...body }: MoveBody) =>
      unwrap(await api.POST('/api/files/copy', { body: { ...body, keep_both } })),
    onSuccess: refresh,
  })
}

export function useTrashPath() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (path: string) => unwrap(await api.POST('/api/files/trash', { body: { path } })),
    onSuccess: refresh,
  })
}

export function useRestore() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.POST('/api/files/trash/{item_id}/restore', { params: { path: { item_id: id } } })),
    onSuccess: refresh,
  })
}

export function usePurge() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/files/trash/{item_id}', { params: { path: { item_id: id } } })),
    onSuccess: refresh,
  })
}

export function useUpload() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async ({ folder, files }: { folder: string; files: File[] }) => {
      const form = new FormData()
      form.append('folder', folder)
      files.forEach((f) => form.append('files', f))
      const res = await fetch('/api/files/upload', { method: 'POST', body: form, credentials: 'same-origin' })
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
      if (!res.ok) throw new ApiError(res.status, body.error?.code ?? 'upload_failed', body.error?.message ?? 'Upload failed')
      return body as unknown as Entry[]
    },
    onSuccess: refresh,
  })
}

export function downloadUrl(path: string): string {
  return `/api/files/download?path=${encodeURIComponent(path)}`
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name
}
