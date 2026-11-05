/**
 * One day's daily note, and changes to it that show at once and are saved right
 * after (see dailyNote.ts).
 *
 * The cache holds two things: the note as the server has it (`note`, whose hash the
 * next save is based on) and the text shown (`content`): the server's text with the
 * changes not saved yet applied on top. Every fetch (after a save in another tab, an
 * agent's edit, the document editor) applies those changes again, so they never
 * disappear; and when the file changed elsewhere before they were saved, they are
 * simply applied to the newer text and saved again.
 */
import { useCallback, useState } from 'react'
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, errorMessage, type Schemas, unwrap } from '@/api/client'
import type { NoteChange } from './dailyNote'

export type DailyNote = Schemas['DailyNoteOut']
type Cached = { note: DailyNote; content: string }

/** Under ['documents', …], so a saved document (here or elsewhere) refreshes it.
 *  `day` is a date (YYYY-MM-DD) or "today" (the server knows which day that is). */
export const dailyNoteKey = (day: string, projectId: string | null) => ['documents', 'daily', day, projectId] as const

type Pending = { key: string; change: NoteChange }
// Changes not saved yet, oldest first, for every day and project (a change made just
// before going to another day still gets saved). Module-wide: one list per browser tab.
let pending: Pending[] = []
let saving = false

const keyOf = (day: string, projectId: string | null) => JSON.stringify(dailyNoteKey(day, projectId))
const withPending = (note: DailyNote, key: string): Cached => ({
  note,
  content: pending.filter((p) => p.key === key).reduce<string>((text, p) => p.change(text), note.document?.content ?? ''),
})

async function fetchNote(day: string, projectId: string | null): Promise<Cached> {
  const note = unwrap(await api.GET('/api/daily-notes/{day}', { params: { path: { day }, query: projectId ? { project_id: projectId } : {} } }))
  return withPending(note, keyOf(day, projectId))
}

async function flush(qc: QueryClient, onError: (message: string | null) => void) {
  if (saving) return
  saving = true
  let conflicts = 0
  try {
    while (pending.length) {
      const key = pending[0].key
      const [, , day, projectId] = JSON.parse(key) as [string, string, string, string | null]
      const queryKey = dailyNoteKey(day, projectId)
      const batch = pending.filter((p) => p.key === key)
      const base = qc.getQueryData<Cached>(queryKey)?.note ?? (await qc.fetchQuery({ queryKey, queryFn: () => fetchNote(day, projectId) })).note
      const content = batch.reduce<string>((text, p) => p.change(text), base.document?.content ?? '')
      try {
        const saved = unwrap(
          await api.PUT('/api/daily-notes/{day}', {
            params: { path: { day }, query: projectId ? { project_id: projectId } : {} },
            body: { content, base_hash: base.document?.hash ?? null },
          }),
        )
        pending = pending.filter((p) => !batch.includes(p))
        qc.setQueryData<Cached>(queryKey, withPending(saved, key))
        conflicts = 0
        onError(null)
      } catch (err) {
        if (err instanceof ApiError && err.code === 'conflict_base_hash' && conflicts < 3) {
          // Changed elsewhere: fetch the newer text; the changes are applied to it again.
          conflicts++
          await qc.fetchQuery({ queryKey, queryFn: () => fetchNote(day, projectId), staleTime: 0 })
          continue
        }
        pending = pending.filter((p) => !batch.includes(p))
        const cached = qc.getQueryData<Cached>(queryKey)
        if (cached) qc.setQueryData<Cached>(queryKey, withPending(cached.note, key))
        void qc.invalidateQueries({ queryKey })
        onError(errorMessage(err))
      }
    }
  } finally {
    saving = false
  }
}

export function useDailyNote(day: string, projectId: string | null) {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: dailyNoteKey(day, projectId), queryFn: () => fetchNote(day, projectId) })
  const [error, setError] = useState<string | null>(null)

  const apply = useCallback(
    (change: NoteChange) => {
      const qk = dailyNoteKey(day, projectId)
      const cached = qc.getQueryData<Cached>(qk)
      if (!cached) return
      pending = [...pending, { key: keyOf(day, projectId), change }]
      qc.setQueryData<Cached>(qk, { note: cached.note, content: change(cached.content) })
      void flush(qc, setError)
    },
    [day, projectId, qc],
  )

  return { note: query.data?.note, content: query.data?.content ?? '', ready: query.isSuccess, isError: query.isError, error, apply }
}
