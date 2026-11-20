import type { EventContentArg } from '@fullcalendar/core'
import { SourceBadge } from '@/features/provenance/Provenance'
import type { Occurrence } from '../api'

/**
 * A synced event in the month, week, day and agenda views: drawn like FullCalendar draws
 * events, with its source badge after the title (a click on the badge opens the original,
 * not the event: see onSourceLink). Other events keep FullCalendar's own drawing.
 */
export function SyncedEventContent({ arg, occurrence }: { arg: EventContentArg; occurrence: Occurrence }) {
  const list = arg.view.type.startsWith('list') // the time has its own column there
  const dot = arg.view.type.startsWith('dayGrid') && !arg.event.allDay
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {dot && <span className="fc-daygrid-event-dot" />}
      {!list && arg.timeText && <span className="fc-event-time shrink-0">{arg.timeText}</span>}
      <span className="fc-event-title min-w-0 truncate">{arg.event.title}</span>
      <SourceBadge item={occurrence} className="shrink-0" />
    </span>
  )
}
