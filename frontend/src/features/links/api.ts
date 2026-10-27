import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type Schemas, unwrap } from '@/api/client'

export type TaskFile = Schemas['TaskFileOut']
export type Backlinks = Schemas['Backlinks']

const taskFilesKey = (taskId: string) => ['tasks', 'files', taskId] as const

/** A task's attachments (files that stay in Files). */
export function useTaskFiles(taskId: string | null) {
  return useQuery({
    queryKey: taskFilesKey(taskId ?? 'none'),
    enabled: !!taskId,
    queryFn: async () => unwrap(await api.GET('/api/tasks/{task_id}/files', { params: { path: { task_id: taskId! } } })),
  })
}

function useSetFiles(taskId: string) {
  const qc = useQueryClient()
  return (files: TaskFile[]) => qc.setQueryData(taskFilesKey(taskId), files)
}

export function useAttachFile(taskId: string) {
  const set = useSetFiles(taskId)
  return useMutation({
    mutationFn: async (path: string) =>
      unwrap(await api.POST('/api/tasks/{task_id}/files', { params: { path: { task_id: taskId } }, body: { path } })),
    onSuccess: set,
  })
}

/** Upload files into the task's project folder (or files/) and attach them. */
export function useUploadToTask(taskId: string) {
  const qc = useQueryClient()
  const set = useSetFiles(taskId)
  return useMutation({
    mutationFn: async (files: File[]) => {
      const form = new FormData()
      for (const f of files) form.append('files', f)
      const res = await fetch(`/api/tasks/${taskId}/files/upload`, { method: 'POST', body: form, credentials: 'same-origin' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
        throw new ApiError(res.status, body.error?.code ?? `http_${res.status}`, body.error?.message ?? 'Upload failed')
      }
      return (await res.json()) as TaskFile[]
    },
    onSuccess: (files) => {
      set(files)
      void qc.invalidateQueries({ queryKey: ['files'] })
    },
  })
}

export function useDetachFile(taskId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (path: string) =>
      unwrap(await api.DELETE('/api/tasks/{task_id}/files', { params: { path: { task_id: taskId }, query: { path } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: taskFilesKey(taskId) }),
  })
}

/** Where a file is used (tasks and documents). */
export function useFileBacklinks(path: string | null) {
  return useQuery({
    queryKey: ['files', 'links', path],
    enabled: !!path,
    queryFn: async () => unwrap(await api.GET('/api/files/links', { params: { query: { path: path! } } })),
  })
}

export async function fileBacklinks(path: string): Promise<Backlinks> {
  return unwrap(await api.GET('/api/files/links', { params: { query: { path } } }))
}

/** Documents and tasks that link to a document. */
export function useDocumentBacklinks(documentId: string) {
  return useQuery({
    queryKey: ['documents', 'backlinks', documentId],
    queryFn: async () =>
      unwrap(await api.GET('/api/documents/{document_id}/backlinks', { params: { path: { document_id: documentId } } })),
  })
}

/** Documents (and other tasks' notes) that link to a task. */
export function useTaskBacklinks(taskId: string | null) {
  return useQuery({
    queryKey: ['tasks', 'backlinks', taskId],
    enabled: !!taskId,
    queryFn: async () => unwrap(await api.GET('/api/tasks/{task_id}/backlinks', { params: { path: { task_id: taskId! } } })),
  })
}

/** "Linked from 2 tasks and 1 document", or null when nothing links to it. */
export function linkedFromText(b: Backlinks): string | null {
  const parts = [
    b.tasks.length ? `${b.tasks.length} task${b.tasks.length === 1 ? '' : 's'}` : '',
    b.documents.length ? `${b.documents.length} document${b.documents.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  return parts.length ? `Linked from ${parts.join(' and ')}.` : null
}
