import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type Schemas, unwrap } from '@/api/client'
import { plural, t } from '@/lib/i18n'

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
    // One request per file, so a large batch stays under a proxy's size limit and a file
    // that fails doesn't keep the others out. The first failure is reported at the end.
    mutationFn: async (files: File[]) => {
      let failure: ApiError | null = null
      for (const f of files) {
        const form = new FormData()
        form.append('files', f)
        const res = await fetch(`/api/tasks/${taskId}/files/upload`, { method: 'POST', body: form, credentials: 'same-origin' })
          .catch(() => null)
        if (res?.ok) {
          set((await res.json()) as TaskFile[])
          continue
        }
        const body = (await res?.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } | undefined
        failure ??= new ApiError(res?.status ?? 0, body?.error?.code ?? `http_${res?.status ?? 0}`,
          `${f.name}: ${body?.error?.message ?? (res?.status === 413 ? t('Too large for the server (or a proxy in front of it)') : t('Upload failed'))}`)
      }
      if (failure) throw failure
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['files'] }),
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
  const tasks = b.tasks.length ? plural(b.tasks.length, '{n} task', '{n} tasks') : ''
  const documents = b.documents.length ? plural(b.documents.length, '{n} document', '{n} documents') : ''
  if (tasks && documents) return t('Linked from {tasks} and {documents}.', { tasks, documents })
  return tasks || documents ? t('Linked from {items}.', { items: tasks || documents }) : null
}

// -- the link index: links and backlinks of documents, tasks, events and chats ----------------

export type LinkType = 'document' | 'task' | 'event' | 'chat'
export type LinksOut = Schemas['LinksOut']
export type LinkGroups = Schemas['LinkGroups']
export type LinkOut = Schemas['LinkOut']
export type LinkItem = Schemas['LinkItem']
export type BrokenLink = Schemas['BrokenLinkOut']

export const LINK_TYPES: LinkType[] = ['document', 'task', 'event', 'chat']
export const linksKey = (type: LinkType, id: string) => ['links', type, id] as const
export const brokenLinksKey = ['links', 'broken'] as const

/** What an item links to and what links to it ("Linked from"), grouped by type. */
export function useLinks(type: LinkType, id: string | null) {
  return useQuery({
    queryKey: linksKey(type, id ?? 'none'),
    enabled: !!id,
    queryFn: async () =>
      unwrap(await api.GET('/api/links/{object_type}/{object_id}', { params: { path: { object_type: type, object_id: id! } } })),
  })
}

function useLinkChanged() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ['links'] })
    void qc.invalidateQueries({ queryKey: ['tasks', 'backlinks'] })
    void qc.invalidateQueries({ queryKey: ['documents', 'backlinks'] })
  }
}

/** Link a task or event to other items (their references). */
export function useAddLinks(type: 'task' | 'event', id: string) {
  const changed = useLinkChanged()
  return useMutation({
    mutationFn: async (to: string[]) =>
      unwrap(await api.POST('/api/links/{object_type}/{object_id}', { params: { path: { object_type: type, object_id: id } }, body: { to } })),
    onSuccess: changed,
  })
}

/** Remove a link set on a task or event (one written in its text goes with the text). */
export function useRemoveLink(type: 'task' | 'event', id: string) {
  const changed = useLinkChanged()
  return useMutation({
    mutationFn: async (to: string) =>
      unwrap(await api.DELETE('/api/links/{object_type}/{object_id}', { params: { path: { object_type: type, object_id: id }, query: { to } } })),
    onSuccess: changed,
  })
}

/** Links to items deleted for good, and the items they are in. */
export function useBrokenLinks() {
  return useQuery({
    queryKey: brokenLinksKey,
    staleTime: 60_000,
    queryFn: async () => unwrap(await api.GET('/api/links/broken')),
  })
}

/** Make a document for an event's meeting notes, linked both ways. */
export function useCreateMeetingNotes() {
  const changed = useLinkChanged()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (eventId: string) =>
      unwrap(await api.POST('/api/calendar/events/{event_id}/meeting-notes', { params: { path: { event_id: eventId } } })),
    onSuccess: () => {
      changed()
      void qc.invalidateQueries({ queryKey: ['documents'] })
    },
  })
}

/** Every link in the groups, in type order. */
export function allLinks(groups: LinkGroups | undefined): LinkOut[] {
  return groups ? LINK_TYPES.flatMap((type) => groups[type] ?? []) : []
}

export type LinkTarget = Schemas['LinkItem']

/** What these references (/tasks?task=<id>, ...) point to now, in the same order: titles for a list of items named by reference. */
export function useLinkTargets(refs: string[]) {
  return useQuery({
    queryKey: ['links', 'targets', refs] as const,
    enabled: refs.length > 0,
    staleTime: 30_000,
    queryFn: async () => unwrap(await api.POST('/api/links/targets', { body: { refs } })),
  })
}
