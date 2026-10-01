import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

export type Occurrence = Schemas['OccurrenceOut']
export type CalendarEvent = Schemas['EventOut']
export type EventInput = Schemas['EventIn']
export type OccurrenceChange = Schemas['OccurrenceIn']

export const calendarKey = ['calendar'] as const

/** The browser's time zone, e.g. "Europe/Amsterdam": new events are stored in it. */
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/** Event occurrences in a range (ISO instants); repeating events come expanded. */
export function useOccurrences(range: { start: string; end: string } | null) {
  return useQuery({
    queryKey: [...calendarKey, 'range', range?.start, range?.end],
    enabled: range !== null,
    // Keep showing the previous range while the next one loads (no flicker when paging).
    placeholderData: (previous) => previous,
    queryFn: async () =>
      unwrap(await api.GET('/api/calendar/events', { params: { query: { start: range!.start, end: range!.end } } })),
  })
}

/** The stored event behind an occurrence (for a repeating event: the whole series). */
export function useEvent(id: string | null) {
  return useQuery({
    queryKey: [...calendarKey, 'event', id],
    enabled: Boolean(id),
    queryFn: async () =>
      unwrap(await api.GET('/api/calendar/events/{event_id}', { params: { path: { event_id: id! } } })),
  })
}

function useRefresh() {
  const qc = useQueryClient()
  return () => void qc.invalidateQueries({ queryKey: calendarKey })
}

/** Create an event, or change an existing one (for a repeating event: the series). */
export function useSaveEvent() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (v: { id?: string; body: EventInput }) =>
      v.id
        ? unwrap(await api.PUT('/api/calendar/events/{event_id}', { params: { path: { event_id: v.id } }, body: v.body }))
        : unwrap(await api.POST('/api/calendar/events', { body: v.body })),
    onSettled: refresh,
  })
}

export function useDeleteEvent() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/calendar/events/{event_id}', { params: { path: { event_id: id } } })),
    onSettled: refresh,
  })
}

/** Change or cancel one occurrence of a repeating event. */
export function useChangeOccurrence() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (v: { eventId: string; originalStart: string; body: Partial<OccurrenceChange> }) =>
      unwrap(
        await api.PUT('/api/calendar/events/{event_id}/occurrences/{original_start}', {
          params: { path: { event_id: v.eventId, original_start: v.originalStart } },
          body: { cancelled: false, ...v.body },
        }),
      ),
    onSettled: refresh,
  })
}
