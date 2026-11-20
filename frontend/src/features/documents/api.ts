import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type Schemas, unwrap } from '@/api/client'
import { t } from '@/lib/i18n'

export type HubSection = Schemas['HubSection']
export type DocumentSummary = Schemas['DocumentOut']
export type DocumentContent = Schemas['DocumentContent']
export type Revision = Schemas['RevisionOut']

export const documentsKey = ['documents'] as const
export const documentKey = (id: string) => ['document', id] as const
export const revisionsKey = (id: string) => ['document', id, 'revisions'] as const

export function useDocuments() {
  return useQuery({
    queryKey: documentsKey,
    queryFn: async () => unwrap(await api.GET('/api/documents')),
  })
}

export function useDocument(id: string) {
  return useQuery({
    queryKey: documentKey(id),
    queryFn: async () =>
      unwrap(await api.GET('/api/documents/{document_id}', { params: { path: { document_id: id } } })),
  })
}

export function useCreateDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { title: string; folder: string }) =>
      unwrap(await api.POST('/api/documents', { body: { title: v.title, folder: v.folder, content: null } })),
    onSuccess: (doc) => {
      qc.setQueryData(documentKey(doc.id), doc)
      void qc.invalidateQueries({ queryKey: documentsKey })
    },
  })
}

/** Saves the text. `baseHash` null overwrites whatever is there (after a conflict). */
export async function saveDocument(id: string, content: string, baseHash: string | null): Promise<DocumentContent> {
  return unwrap(
    await api.PUT('/api/documents/{document_id}', {
      params: { path: { document_id: id } },
      body: { content, base_hash: baseHash },
    }),
  )
}

export function useMoveDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; name?: string; folder?: string }) =>
      unwrap(
        await api.POST('/api/documents/{document_id}/move', {
          params: { path: { document_id: v.id } },
          body: { name: v.name ?? null, folder: v.folder ?? null },
        }),
      ),
    onSuccess: (doc) => {
      void qc.invalidateQueries({ queryKey: documentsKey })
      void qc.invalidateQueries({ queryKey: documentKey(doc.id) })
    },
  })
}

export function useDeleteDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/documents/{document_id}', { params: { path: { document_id: id } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: documentsKey }),
  })
}

export function useRevisions(id: string, enabled: boolean) {
  return useQuery({
    queryKey: revisionsKey(id),
    enabled,
    queryFn: async () =>
      unwrap(await api.GET('/api/documents/{document_id}/revisions', { params: { path: { document_id: id } } })),
  })
}

export function useRevision(id: string, revisionId: string | null) {
  return useQuery({
    queryKey: [...revisionsKey(id), revisionId],
    enabled: Boolean(revisionId),
    queryFn: async () =>
      unwrap(
        await api.GET('/api/documents/{document_id}/revisions/{revision_id}', {
          params: { path: { document_id: id, revision_id: revisionId! } },
        }),
      ),
  })
}

export function useRestoreRevision(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (revisionId: string) =>
      unwrap(
        await api.POST('/api/documents/{document_id}/revisions/{revision_id}/restore', {
          params: { path: { document_id: id, revision_id: revisionId } },
        }),
      ),
    onSuccess: (doc) => {
      qc.setQueryData(documentKey(id), doc)
      void qc.invalidateQueries({ queryKey: revisionsKey(id) })
      void qc.invalidateQueries({ queryKey: documentsKey })
    },
  })
}

/** Uploads an image for a document; returns its workspace path (documents/_assets/...). */
export async function uploadAsset(file: File): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/documents/assets', { method: 'POST', body: form, credentials: 'same-origin' })
  const body = (await res.json().catch(() => ({}))) as { path?: string; error?: { code?: string; message?: string } }
  if (!res.ok || !body.path) {
    throw new ApiError(res.status, body.error?.code ?? 'upload_failed', body.error?.message ?? t('Upload failed'))
  }
  return body.path
}

export const hubKey = (id: string) => ['document', id, 'hub'] as const

/**
 * Changes properties: the server rewrites the front matter through the normal save (a
 * revision). `baseHash` is the version the editor has; a change made elsewhere since is a
 * conflict. The new text goes into the cache, so the open editor picks it up.
 */
export function useSetProperties(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { set: Record<string, unknown>; baseHash: string | null; createValues?: boolean }) =>
      unwrap(
        await api.PUT('/api/documents/{document_id}/properties', {
          params: { path: { document_id: id } },
          body: { set: v.set, base_hash: v.baseHash, create_values: v.createValues ?? false },
        }),
      ),
    onSuccess: (doc) => {
      qc.setQueryData(documentKey(id), doc)
      void qc.invalidateQueries({ queryKey: documentsKey })
      void qc.invalidateQueries({ queryKey: ['properties'] })
      void qc.invalidateQueries({ queryKey: ['views'] })
    },
  })
}

/** When the document is the hub page of property values: everything with each value. */
export function useHub(id: string) {
  return useQuery({
    queryKey: hubKey(id),
    queryFn: async () =>
      unwrap(await api.GET('/api/documents/{document_id}/hub', { params: { path: { document_id: id } } })),
  })
}

/** After a move: the new folder's default properties the document doesn't have. */
export async function folderDefaults(id: string): Promise<Record<string, unknown>> {
  return unwrap(await api.GET('/api/documents/{document_id}/folder-defaults', { params: { path: { document_id: id } } }))
}

/** After a move: project instructions and memories that still name the old path. */
export async function oldPathMentions(id: string, oldPath: string) {
  return unwrap(
    await api.GET('/api/documents/{document_id}/mentions', {
      params: { path: { document_id: id }, query: { old_path: oldPath } },
    }),
  )
}

export async function updateMentions(id: string, oldPath: string, items: { kind: 'project' | 'memory'; id: string }[]) {
  return unwrap(
    await api.POST('/api/documents/{document_id}/mentions', {
      params: { path: { document_id: id } },
      body: { old_path: oldPath, items },
    }),
  )
}
