import { dayOf } from '@/features/tasks/dates'
import type { CalendarEvent } from './api'

/**
 * The day the calendar shows for an event opened by its link: the day it starts, or for a
 * repeating event that started before `today`, today (where its next occurrences are).
 */
export function linkedEventDay(event: CalendarEvent, today: string): string {
  const first = event.all_day && event.start_date ? event.start_date : dayOf(new Date(event.start_at))
  return event.rrule && first < today ? today : first
}
