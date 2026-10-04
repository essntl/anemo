/**
 * Calendar: month, week, day and agenda views (FullCalendar). It shows events
 * (repeating ones already expanded by the server) and tasks on their due dates.
 * Click a day to add an event, click an entry to open it, drag to move it.
 *
 * On a phone it is laid out like a phone's calendar: the month is a grid of days with
 * dots and the chosen day's list under it, "Week" is three days, the agenda two weeks,
 * and "+" floats at the bottom.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DayCellContentArg, EventDropArg, EventInput } from '@fullcalendar/core'
import dayGridPlugin from '@fullcalendar/daygrid'
import interactionPlugin, { type DateClickArg, type EventResizeDoneArg } from '@fullcalendar/interaction'
import listPlugin from '@fullcalendar/list'
import FullCalendar from '@fullcalendar/react'
import timeGridPlugin from '@fullcalendar/timegrid'
import { useSearchParams } from 'react-router'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { useCurrentProject } from '@/app/projectStore'
import { Button } from '@/components/ui/Button'
import { type Task, useTasksDue, useUpdateTask } from '@/features/tasks/api'
import { TaskDialog } from '@/features/tasks/components/TaskDialog'
import { addDays, dayOf, today } from '@/features/tasks/dates'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { browserTimeZone, type Occurrence, useChangeOccurrence, useOccurrences, useSaveEvent } from './api'
import { DayList } from './components/DayList'
import { colorOf, daysOf } from './entries'
import { EventDialog, type NewEventDefaults } from './components/EventDialog'
import { Lingering } from '@/components/ui/Lingering'

type View = 'month' | 'week' | 'day' | 'agenda'
/** The FullCalendar view behind each choice; a phone has no room for seven time columns. */
const FC_VIEW: Record<View, { desktop: string; phone: string }> = {
  month: { desktop: 'dayGridMonth', phone: 'dayGridMonth' },
  week: { desktop: 'timeGridWeek', phone: 'timeGridThreeDay' },
  day: { desktop: 'timeGridDay', phone: 'timeGridDay' },
  agenda: { desktop: 'listWeek', phone: 'listTwoWeeks' },
}
const VIEW_LABEL: Record<View, { desktop: string; phone: string }> = {
  month: { desktop: 'Month', phone: 'Month' },
  week: { desktop: 'Week', phone: '3 days' },
  day: { desktop: 'Day', phone: 'Day' },
  agenda: { desktop: 'Agenda', phone: 'Agenda' },
}
const CUSTOM_VIEWS = {
  timeGridThreeDay: { type: 'timeGrid', duration: { days: 3 } },
  listTwoWeeks: { type: 'list', duration: { weeks: 2 } },
}
const TIME_FORMAT = { hour: '2-digit', minute: '2-digit', hour12: false } as const
const HOUR_FORMAT = { hour: '2-digit', hour12: false } as const

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
  const device = desktop ? 'desktop' : 'phone'
  const [view, setView] = useState<View>(desktop ? 'month' : 'agenda')
  // Phone month: the day whose entries are listed under the grid.
  const [selected, setSelected] = useState(startDate ?? today())
  const phoneMonth = !desktop && view === 'month'
  const [range, setRange] = useState<{ start: string; end: string } | null>(null)
  const [title, setTitle] = useState('')
  const [open, setOpen] = useState<Open>(null)
  // With a project chosen in the sidebar: only its events and its tasks.
  const project = useCurrentProject()
  const occurrences = useOccurrences(range, project?.id ?? null)
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
    const due = (tasks.data ?? []).filter((t) => !project || t.project_id === project.id).map((t) => ({
      id: `task:${t.id}`,
      title: t.title,
      start: t.due_time ? `${t.due_date}T${t.due_time}` : t.due_date!,
      allDay: !t.due_time,
      durationEditable: false,
      classNames: ['fc-task', ...(t.status === 'done' || t.status === 'cancelled' ? ['fc-task-done'] : [])],
      extendedProps: { task: t },
    }))
    return [...events, ...due]
  }, [occurrences.data, tasks.data, project])

  const api = () => calendar.current?.getApi()
  const changeView = (next: View) => {
    setView(next)
    api()?.changeView(FC_VIEW[next][device])
  }
  // Turning a tablet or resizing the window: the same choice, in the other layout.
  useEffect(() => {
    api()?.changeView(FC_VIEW[view][device])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device])
  // A time grid opens at 7:00 (scrollTime only applies to the first view shown, and a
  // phone starts in the agenda).
  useEffect(() => {
    if (view !== 'week' && view !== 'day') return
    const frame = requestAnimationFrame(() => api()?.scrollToTime('07:00:00'))
    return () => cancelAnimationFrame(frame)
  }, [view, device])

  // Phone month: which days have something on them, with up to three colours each.
  const dots = useMemo(() => {
    const byDay = new Map<string, (string | null)[]>()
    for (const e of entries) for (const d of daysOf(e)) byDay.set(d, [...(byDay.get(d) ?? []), colorOf(e)])
    return byDay
  }, [entries])
  const dayCell = (arg: DayCellContentArg) => {
    const found = dots.get(dayOf(arg.date)) ?? []
    return (
      <div className="flex flex-col items-center gap-1 py-1">
        <span className="fc-phone-day-number">{arg.date.getDate()}</span>
        <span className="flex h-1.5 items-center gap-0.5" aria-label={found.length ? `${found.length} planned` : undefined}>
          {found.slice(0, 3).map((color, i) => (
            <span key={i} className={cn('h-1.5 w-1.5 rounded-full', !color && 'border border-muted')}
              style={color ? { backgroundColor: color } : undefined} />
          ))}
        </span>
      </div>
    )
  }
  const openEntry = (entry: EventInput) => {
    const task = entry.extendedProps?.task as Task | undefined
    if (task) setOpen({ kind: 'task', task })
    else setOpen({ kind: 'event', occurrence: entry.extendedProps?.occurrence as Occurrence })
  }
  const newEvent = () =>
    setOpen({ kind: 'event', occurrence: null, defaults: { date: phoneMonth ? selected : dayOf(new Date()), time: '09:00' } })

  const onDateClick = (arg: DateClickArg) => {
    // Phone month: a tap chooses the day (its list shows below); "+" adds to it.
    if (phoneMonth) return setSelected(arg.dateStr.slice(0, 10))
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

  const segmented = (
    <div className="flex rounded-lg bg-surface-2 p-0.5 max-md:w-full" role="radiogroup" aria-label="View">
      {(Object.keys(FC_VIEW) as View[]).map((v) => (
        <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => changeView(v)}
          className={cn('h-8 rounded-md px-3 text-[13px] font-medium transition-colors max-md:h-9 max-md:flex-1',
            view === v ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}>
          {VIEW_LABEL[v][device]}
        </button>
      ))}
    </div>
  )

  return (
    <div className={cn('flex h-full flex-col px-3 pb-3 pt-2 md:p-6', phoneMonth && 'overflow-y-auto pb-24')}>
      <div className="mb-3 flex flex-wrap items-center gap-2 md:flex-nowrap">
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          <Button size="icon" variant="ghost" aria-label="Previous" onClick={() => api()?.prev()}><ChevronLeft className="h-4 w-4" /></Button>
          <h1 className="min-w-0 truncate px-1 text-[17px] font-semibold md:text-xl" aria-live="polite">{title || 'Calendar'}</h1>
          <Button size="icon" variant="ghost" aria-label="Next" onClick={() => api()?.next()}><ChevronRight className="h-4 w-4" /></Button>
        </div>
        <Button size="sm" variant="secondary" onClick={() => { api()?.today(); setSelected(today()) }}>Today</Button>
        <div className="hidden md:block">{segmented}</div>
        <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={newEvent} className="hidden md:inline-flex">
          New event
        </Button>
        <div className="w-full md:hidden">{segmented}</div>
      </div>
      {error && <p className="mb-2 text-[13px] text-error">{errorMessage(error)}</p>}

      <div className={cn(
        'rounded-card border border-border bg-card p-2 shadow-soft md:p-3',
        // A phone's calendar has the whole width; the month grid sizes itself, the rest fills.
        desktop ? 'min-h-0 flex-1' : 'border-0 bg-transparent p-0 shadow-none',
        !desktop && !phoneMonth && 'min-h-0 flex-1',
        !desktop && 'fc-phone',
      )}>
        <FullCalendar
          ref={calendar}
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
          views={CUSTOM_VIEWS}
          initialView={FC_VIEW[view][device]}
          initialDate={startDate}
          headerToolbar={false}
          height={phoneMonth ? 'auto' : '100%'}
          locale={navigator.language}
          firstDay={1}
          nowIndicator
          dayMaxEvents
          dayMaxEventRows={desktop ? true : 2}
          fixedWeekCount={desktop}
          editable
          eventDisplay={phoneMonth ? 'none' : 'auto'}
          dayCellContent={phoneMonth ? dayCell : undefined}
          dayCellClassNames={(arg) => (phoneMonth && dayOf(arg.date) === selected ? ['fc-day-selected'] : [])}
          eventTimeFormat={TIME_FORMAT}
          slotLabelFormat={desktop ? TIME_FORMAT : HOUR_FORMAT}
          dayHeaderFormat={desktop || view === 'month' ? undefined : { weekday: 'short', day: 'numeric' }}
          listDayFormat={{ weekday: 'short', month: 'short', day: 'numeric' }}
          listDaySideFormat={false}
          scrollTime="07:00:00"
          events={entries}
          datesSet={(arg) => {
            setRange({ start: arg.start.toISOString(), end: arg.end.toISOString() })
            setTitle(arg.view.title)
          }}
          dateClick={onDateClick}
          eventClick={(arg) => openEntry({ extendedProps: arg.event.extendedProps })}
          eventDrop={onMoved}
          eventResize={onMoved}
          noEventsContent="Nothing planned"
        />
      </div>
      {phoneMonth && <DayList day={selected} entries={entries} onOpen={openEntry} />}

      {/* Phones: "+" where the thumb is. */}
      {!desktop && (
        <button type="button" aria-label="New event" onClick={newEvent}
          className="fixed bottom-[calc(env(safe-area-inset-bottom)+1.25rem)] right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-contrast shadow-float active:scale-95">
          <Plus className="h-6 w-6" />
        </button>
      )}

      <Lingering value={open?.kind === 'event' && open}>
        {(shown) => <EventDialog occurrence={shown.occurrence} defaults={shown.defaults} onClose={() => setOpen(null)} />}
      </Lingering>
      <Lingering value={open?.kind === 'task' && open}>{(shown) => <TaskDialog task={shown.task} onClose={() => setOpen(null)} />}</Lingering>
    </div>
  )
}
