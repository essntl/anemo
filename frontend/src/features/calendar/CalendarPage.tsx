/**
 * Calendar: month, week, day and agenda views (FullCalendar). It shows events
 * (repeating ones already expanded by the server) and tasks on their due dates.
 * Click a day to add an event, click an entry to open it, drag to move it.
 */
import { useMemo, useRef, useState } from 'react'
import type { EventDropArg, EventInput } from '@fullcalendar/core'
import dayGridPlugin from '@fullcalendar/daygrid'
import interactionPlugin, { type DateClickArg, type EventResizeDoneArg } from '@fullcalendar/interaction'
import listPlugin from '@fullcalendar/list'
import FullCalendar from '@fullcalendar/react'
import timeGridPlugin from '@fullcalendar/timegrid'
import { useSearchParams } from 'react-router'
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { type Task, useTasksDue, useUpdateTask } from '@/features/tasks/api'
import { TaskDialog } from '@/features/tasks/components/TaskDialog'
import { addDays, dayOf } from '@/features/tasks/dates'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { browserTimeZone, type Occurrence, useChangeOccurrence, useOccurrences, useSaveEvent } from './api'
import { EventDialog, type NewEventDefaults } from './components/EventDialog'
import { Lingering } from '@/components/ui/Lingering'

const VIEWS = [
  { value: 'dayGridMonth', label: 'Month' },
  { value: 'timeGridWeek', label: 'Week' },
  { value: 'timeGridDay', label: 'Day' },
  { value: 'listWeek', label: 'Agenda' },
]
const TIME_FORMAT = { hour: '2-digit', minute: '2-digit', hour12: false } as const

type Open =
  | { kind: 'event'; occurrence: Occurrence | null; defaults?: NewEventDefaults }
  | { kind: 'task'; task: Task }
  | null

export function CalendarPage() {
  const calendar = useRef<FullCalendar>(null)
  // /calendar?date=2026-10-10 (e.g. from search) starts on that day.
  const [params] = useSearchParams()
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date')! : undefined
  const desktop = useMediaQuery(DESKTOP)
  const [view, setView] = useState(desktop ? 'dayGridMonth' : 'listWeek')
  const [range, setRange] = useState<{ start: string; end: string } | null>(null)
  const [title, setTitle] = useState('')
  const [open, setOpen] = useState<Open>(null)
  const occurrences = useOccurrences(range)
  const tasks = useTasksDue(range ? dayOf(new Date(range.start)) : null, range ? dayOf(new Date(range.end)) : null)
  const saveEvent = useSaveEvent()
  const changeOccurrence = useChangeOccurrence()
  const updateTask = useUpdateTask()
  const error = occurrences.error ?? saveEvent.error ?? changeOccurrence.error ?? updateTask.error

  const entries = useMemo<EventInput[]>(() => {
    const events = (occurrences.data ?? []).map((o) => ({
      id: `${o.event_id}:${o.original_start}`,
      title: o.title,
      start: o.all_day ? o.start_date! : o.start_at,
      // FullCalendar's all-day end is the day after the last day.
      end: o.all_day ? addDays(o.end_date!, 1) : o.end_at,
      allDay: o.all_day,
      extendedProps: { occurrence: o },
      ...(o.color ? { backgroundColor: o.color, borderColor: o.color } : {}),
    }))
    const due = (tasks.data ?? []).map((t) => ({
      id: `task:${t.id}`,
      title: t.title,
      start: t.due_time ? `${t.due_date}T${t.due_time}` : t.due_date!,
      allDay: !t.due_time,
      durationEditable: false,
      classNames: ['fc-task', ...(t.status === 'done' || t.status === 'cancelled' ? ['fc-task-done'] : [])],
      extendedProps: { task: t },
    }))
    return [...events, ...due]
  }, [occurrences.data, tasks.data])

  const api = () => calendar.current?.getApi()
  const changeView = (next: string) => {
    setView(next)
    api()?.changeView(next)
  }

  const onDateClick = (arg: DateClickArg) => {
    const defaults = arg.allDay ? { date: arg.dateStr.slice(0, 10) } : { date: dayOf(arg.date), time: arg.date.toTimeString().slice(0, 5) }
    setOpen({ kind: 'event', occurrence: null, defaults })
  }

  /** An entry was dragged to another time (or resized): save its new times. */
  const onMoved = (arg: EventDropArg | EventResizeDoneArg) => {
    const { start, end, allDay } = arg.event
    if (!start) return arg.revert()
    const task = arg.event.extendedProps.task as Task | undefined
    if (task) {
      const body = { due_date: dayOf(start), due_time: allDay ? null : `${start.toTimeString().slice(0, 5)}:00` }
      return updateTask.mutate({ id: task.id, body }, { onError: arg.revert })
    }
    const o = arg.event.extendedProps.occurrence as Occurrence
    const lengthMs = new Date(o.end_at).getTime() - new Date(o.start_at).getTime()
    const until = end ?? new Date(start.getTime() + lengthMs)
    if (o.recurring) {
      // Dragging one occurrence of a repeating event only moves that one.
      return changeOccurrence.mutate(
        { eventId: o.event_id, originalStart: o.original_start, body: { start_at: start.toISOString(), end_at: until.toISOString() } },
        { onError: arg.revert },
      )
    }
    const body = {
      title: o.title, description: o.description, location: o.location, rrule: null, tz: browserTimeZone(),
      remind_minutes: o.remind_minutes, color: o.color, task_id: o.task_id, all_day: allDay,
      start_at: allDay ? null : start.toISOString(),
      end_at: allDay ? null : until.toISOString(),
      start_date: allDay ? dayOf(start) : null,
      end_date: allDay ? addDays(dayOf(until), -1) : null,
    }
    saveEvent.mutate({ id: o.event_id, body }, { onError: arg.revert })
  }

  return (
    <div className="flex h-full flex-col p-3 md:p-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent sm:flex">
          <CalendarDays className="h-5 w-5" />
        </div>
        <h1 className="w-full min-w-0 truncate text-lg font-semibold sm:w-auto sm:flex-1 md:text-xl" aria-live="polite">{title || 'Calendar'}</h1>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" aria-label="Previous" onClick={() => api()?.prev()}><ChevronLeft className="h-4 w-4" /></Button>
          <Button size="sm" variant="secondary" onClick={() => api()?.today()}>Today</Button>
          <Button size="icon" variant="ghost" aria-label="Next" onClick={() => api()?.next()}><ChevronRight className="h-4 w-4" /></Button>
        </div>
        <Select className="h-9 w-32" aria-label="View" value={view} onValueChange={changeView} options={VIEWS} />
        <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />}
          onClick={() => setOpen({ kind: 'event', occurrence: null, defaults: { date: dayOf(new Date()), time: '09:00' } })}>
          New event
        </Button>
      </div>
      {error && <p className="mb-2 text-[13px] text-error">{errorMessage(error)}</p>}

      <div className="min-h-0 flex-1 rounded-card border border-border bg-card p-2 shadow-soft md:p-3">
        <FullCalendar
          ref={calendar}
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
          initialView={view}
          initialDate={startDate}
          headerToolbar={false}
          height="100%"
          locale={navigator.language}
          firstDay={1}
          nowIndicator
          dayMaxEvents
          editable
          eventTimeFormat={TIME_FORMAT}
          slotLabelFormat={TIME_FORMAT}
          scrollTime="07:00:00"
          events={entries}
          datesSet={(arg) => {
            setRange({ start: arg.start.toISOString(), end: arg.end.toISOString() })
            setTitle(arg.view.title)
          }}
          dateClick={onDateClick}
          eventClick={(arg) => {
            const task = arg.event.extendedProps.task as Task | undefined
            if (task) setOpen({ kind: 'task', task })
            else setOpen({ kind: 'event', occurrence: arg.event.extendedProps.occurrence as Occurrence })
          }}
          eventDrop={onMoved}
          eventResize={onMoved}
          noEventsContent="Nothing planned"
        />
      </div>

      <Lingering value={open?.kind === 'event' && open}>
        {(shown) => <EventDialog occurrence={shown.occurrence} defaults={shown.defaults} onClose={() => setOpen(null)} />}
      </Lingering>
      <Lingering value={open?.kind === 'task' && open}>{(shown) => <TaskDialog task={shown.task} onClose={() => setOpen(null)} />}</Lingering>
    </div>
  )
}
