import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'
import { useOutbox } from './outbox'

export type FocusSession = Schemas['FocusSessionOut']
export const focusKey = ['focus'] as const

/** Focus sessions that started in [start, end), newest first. */
export function useFocusSessions(range: { start: Date; end: Date; projectId?: string | null }) {
  const start = range.start.toISOString()
  const end = range.end.toISOString()
  return useQuery({
    queryKey: [...focusKey, 'sessions', start, end, range.projectId ?? null],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/focus/sessions', {
          params: { query: { start, end, project_id: range.projectId ?? undefined } },
        }),
      ),
  })
}

export function startOfToday(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/**
 * Today's focus on this device's calendar day: minutes and sessions, including any
 * still waiting in the offline outbox (so the number is right while offline).
 */
export function useTodayFocus(projectId?: string | null) {
  const start = startOfToday()
  const end = new Date(start.getTime() + 86_400_000)
  const sessions = useFocusSessions({ start, end, projectId })
  const pending = useOutbox((s) => s.pending)
  return useMemo(() => {
    const stored = sessions.data ?? []
    const known = new Set(stored.map((s) => s.client_id))
    const waiting = pending.filter(
      (p) => !known.has(p.clientId) && p.startedAt >= start.getTime() && p.startedAt < end.getTime() && !projectId,
    )
    const minutes = stored.reduce((sum, s) => sum + s.minutes, 0) + waiting.reduce((sum, s) => sum + s.minutes, 0)
    return { minutes, sessions: stored, waiting: waiting.length, isLoading: sessions.isLoading }
    // start/end change once a day; the day key keeps the memo honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.data, sessions.isLoading, pending, projectId, start.getTime()])
}

/** "1h 25m", "45m", "0m". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}
