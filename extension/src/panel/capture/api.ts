/** Saving pages, selections and tasks into Anemo (quick capture). */
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { unwrap } from '@/shared/api'
import type { PageContext } from '@/shared/pageContext'
import { storage, type CaptureStatus } from '@/shared/storage'
import { useStored } from '../state/useStored'
import { useSession } from '../state/useSession'

export type Target = { mode: 'new'; folder?: string } | { mode: 'append'; document_id: string | null }

export function useDocuments() {
  const { api } = useSession()
  return useQuery({
    queryKey: ['documents'],
    staleTime: 60_000,
    queryFn: async () => unwrap(await api.GET('/api/documents')).documents,
  })
}

export function useProjects() {
  const { api } = useSession()
  return useQuery({ queryKey: ['projects'], staleTime: 60_000, queryFn: async () => unwrap(await api.GET('/api/projects')) })
}

export interface CaptureInput {
  page: PageContext
  kind: 'page' | 'selection'
  format?: 'markdown' | 'summary'
  target: Target
  explanation?: string | null
}

export function useStartCapture() {
  const { api } = useSession()
  return useMutation({
    mutationFn: async (input: CaptureInput) => {
      const out = unwrap(
        await api.POST('/api/capture', {
          body: {
            page: { url: input.page.url, title: input.page.title, source: input.page.source, content: input.page.content },
            kind: input.kind,
            format: input.format ?? 'markdown',
            target: input.target.mode === 'new' ? { mode: 'new', folder: input.target.folder ?? 'Web clips' } : { mode: 'append', document_id: input.target.document_id },
            explanation: input.explanation ?? null,
          },
        }),
      )
      return out.id
    },
  })
}

const POLL_MS = 4000

/**
 * A save's progress: from the event stream (the worker keeps it in session storage), with a
 * check every few seconds in case an event was missed.
 */
export function useCaptureStatus(id: string | null): CaptureStatus | null {
  const { api } = useSession()
  const all = useStored('session', 'captures').value
  const status = id ? (all?.[id] ?? null) : null
  const finished = status?.status === 'done' || status?.status === 'failed'
  useEffect(() => {
    if (!id || finished) return
    const timer = window.setInterval(async () => {
      try {
        const latest = unwrap(await api.GET('/api/capture/{capture_id}', { params: { path: { capture_id: id } } }))
        const current = (await storage.get('session', 'captures')) ?? {}
        await storage.set('session', 'captures', { ...current, [id]: latest as CaptureStatus })
      } catch {
        // the stream may still bring it
      }
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [id, finished, api])
  return status
}

/** Undo a save: put the document back as it was, or remove the document the save made. */
export function useUndoCapture() {
  const { api } = useSession()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (undo: NonNullable<CaptureStatus['result']>['undo']) => {
      if (undo.kind === 'delete') {
        unwrap(await api.DELETE('/api/documents/{document_id}', { params: { path: { document_id: undo.document_id } } }))
      } else if (undo.revision_id) {
        unwrap(
          await api.POST('/api/documents/{document_id}/revisions/{revision_id}/restore', {
            params: { path: { document_id: undo.document_id, revision_id: undo.revision_id } },
          }),
        )
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['documents'] }),
  })
}

export interface TaskInput {
  title: string
  description: string
  due_date: string | null
  project_id: string | null
}

export function useCreateTask() {
  const { api } = useSession()
  return useMutation({
    mutationFn: async (t: TaskInput) =>
      unwrap(await api.POST('/api/tasks', { body: { title: t.title, description: t.description, due_date: t.due_date, project_id: t.project_id, status: 'todo', priority: 0 } })),
  })
}
