/**
 * Create or edit a calendar event.
 *
 * For an occurrence of a repeating event the dialog first asks what to change:
 * only this occurrence, or the whole series. The series is then loaded as it is
 * stored (its first occurrence), so its start date is not moved by accident.
 */
import { useState } from 'react'
import { Repeat as RepeatIcon, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { addDays, dayOf, REMINDER_OPTIONS, today } from '@/features/tasks/dates'
import {
  browserTimeZone,
  type CalendarEvent,
  type Occurrence,
  useChangeOccurrence,
  useDeleteEvent,
  useEvent,
  useSaveEvent,
} from '../api'
import { fromRRule, type Repeat, REPEAT_OPTIONS, toRRule } from '../recurrence'

export interface NewEventDefaults {
  date: string // YYYY-MM-DD
  time?: string // HH:mm; omitted: an all-day event
}

type Mode = 'new' | 'event' | 'occurrence'

const timeOf = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

function plusOneHour(time: string): string {
  const [h, m] = time.split(':').map(Number)
  return `${String(Math.min(h + 1, 23)).padStart(2, '0')}:${String(h === 23 ? 59 : m).padStart(2, '0')}`
}

function EventForm({ mode, source, defaults, occurrence, onClose }: {
  mode: Mode
  source: CalendarEvent | null
  defaults?: NewEventDefaults
  /** The occurrence being changed (mode 'occurrence'). */
  occurrence?: Occurrence
  onClose: () => void
}) {
  const save = useSaveEvent()
  const remove = useDeleteEvent()
  const changeOne = useChangeOccurrence()
  const start = source && !source.all_day ? new Date(source.start_at) : null
  const end = source && !source.all_day ? new Date(source.end_at) : null
  const firstDay = source?.start_date ?? (start ? dayOf(start) : (defaults?.date ?? today()))
  const initialRepeat = fromRRule(source?.rrule)

  const [title, setTitle] = useState(source?.title ?? '')
  const [allDay, setAllDay] = useState(source ? source.all_day : !defaults?.time)
  const [startDate, setStartDate] = useState(firstDay)
  const [endDate, setEndDate] = useState(source?.end_date ?? (end ? dayOf(end) : firstDay))
  const [startTime, setStartTime] = useState(start ? timeOf(start) : (defaults?.time ?? '09:00'))
  const [endTime, setEndTime] = useState(end ? timeOf(end) : plusOneHour(defaults?.time ?? '09:00'))
  const [repeat, setRepeat] = useState<Repeat>(initialRepeat.repeat)
  const [until, setUntil] = useState(initialRepeat.until)
  const [remind, setRemind] = useState(source?.remind_minutes != null ? String(source.remind_minutes) : '')
  const [location, setLocation] = useState(source?.location ?? '')
  const [description, setDescription] = useState(source?.description ?? '')

  const startInstant = new Date(`${startDate}T${allDay ? '00:00' : startTime}`)
  const endInstant = allDay ? new Date(`${addDays(endDate, 1)}T00:00`) : new Date(`${endDate}T${endTime}`)
  const invalid = !title.trim() || Number.isNaN(startInstant.getTime()) || Number.isNaN(endInstant.getTime()) || endInstant < startInstant
  const pending = save.isPending || changeOne.isPending
  const error = save.error ?? changeOne.error ?? remove.error

  // Moving the start keeps the event's length.
  const changeStartDate = (next: string) => {
    if (endDate < next || endDate === startDate) setEndDate(next)
    setStartDate(next)
  }
  const changeStartTime = (next: string) => {
    if (startDate === endDate && endTime <= next) setEndTime(plusOneHour(next))
    setStartTime(next)
  }

  const submit = () => {
    if (mode === 'occurrence' && occurrence) {
      changeOne.mutate(
        {
          eventId: occurrence.event_id,
          originalStart: occurrence.original_start,
          body: { title: title.trim(), description, location, start_at: startInstant.toISOString(), end_at: endInstant.toISOString() },
        },
        { onSuccess: onClose },
      )
      return
    }
    const remindMinutes = remind === '' ? null : Number(remind)
    const body = {
      title: title.trim(),
      description,
      location,
      all_day: allDay,
      start_at: allDay ? null : startInstant.toISOString(),
      end_at: allDay ? null : endInstant.toISOString(),
      start_date: allDay ? startDate : null,
      end_date: allDay ? endDate : null,
      tz: browserTimeZone(),
      rrule: toRRule(repeat, until, source?.rrule ?? ''),
      remind_minutes: remindMinutes,
      color: source?.color ?? null,
      task_id: source?.task_id ?? null,
    }
    save.mutate({ id: mode === 'event' ? source?.id : undefined, body }, { onSuccess: onClose })
  }

  const del = () => {
    if (mode === 'occurrence' && occurrence) {
      changeOne.mutate(
        { eventId: occurrence.event_id, originalStart: occurrence.original_start, body: { cancelled: true } },
        { onSuccess: onClose },
      )
    } else if (source) {
      remove.mutate(source.id, { onSuccess: onClose })
    }
  }

  const reminderOptions = REMINDER_OPTIONS.some((o) => o.value === remind)
    ? REMINDER_OPTIONS
    : [...REMINDER_OPTIONS, { value: remind, label: `${remind} minutes before` }]
  const heading = mode === 'new' ? 'New event' : mode === 'occurrence' ? 'This event' : source?.rrule ? 'All events in the series' : 'Event'

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(94vw,560px)]" title={heading}
      footer={
        <>
          {mode !== 'new' && (
            <Button variant="ghost" className="mr-auto" icon={<Trash2 className="h-4 w-4" />} loading={remove.isPending} onClick={del}>
              {mode === 'occurrence' ? 'Delete this one' : source?.rrule ? 'Delete all' : 'Delete'}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={pending} disabled={invalid} onClick={submit}>
            {mode === 'new' ? 'Add event' : 'Save'}
          </Button>
        </>
      }>
      <div className="flex flex-col gap-4">
        <Field label="Title">
          <Input autoFocus={mode === 'new'} value={title} maxLength={300} placeholder="What is it?"
            onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !invalid && submit()} />
        </Field>
        {mode !== 'occurrence' && (
          <div className="flex items-center justify-between text-[13px]">
            <span className="font-medium">All day</span>
            <Switch label="All day" checked={allDay} onChange={setAllDay} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts">
            <Input type="date" value={startDate} onChange={(e) => changeStartDate(e.target.value)} />
          </Field>
          {!allDay && (
            <Field label="Time">
              <Input type="time" value={startTime} onChange={(e) => changeStartTime(e.target.value)} />
            </Field>
          )}
          <Field label="Ends">
            <Input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
          {!allDay && (
            <Field label="Time">
              <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </Field>
          )}
        </div>
        {endInstant < startInstant && <p className="-mt-2 text-[12.5px] text-error">The end is before the start.</p>}
        {mode !== 'occurrence' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Repeat">
              <Select value={repeat} onValueChange={(v) => setRepeat(v as Repeat)}
                options={repeat === 'custom' ? [...REPEAT_OPTIONS, { value: 'custom', label: `Custom (${source?.rrule ?? ''})` }] : REPEAT_OPTIONS} />
            </Field>
            {repeat !== 'none' && repeat !== 'custom' && (
              <Field label="Until (optional)">
                <Input type="date" value={until} min={startDate} onChange={(e) => setUntil(e.target.value)} />
              </Field>
            )}
            <Field label="Reminder">
              <Select value={remind} onValueChange={setRemind} options={reminderOptions} />
            </Field>
          </div>
        )}
        <Field label="Location">
          <Input value={location} maxLength={300} onChange={(e) => setLocation(e.target.value)} />
        </Field>
        <Field label="Notes">
          <Textarea rows={3} value={description} maxLength={20_000} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {source?.created_by === 'agent' && <p className="text-[12px] text-muted">Added by an agent.</p>}
        {error && <p className="text-[12.5px] text-error">{errorMessage(error)}</p>}
      </div>
    </Dialog>
  )
}

/** Edit the stored series: loads it first (the occurrence only knows its own dates). */
function SeriesForm({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const event = useEvent(eventId)
  if (!event.data) return null
  return <EventForm mode="event" source={event.data} onClose={onClose} />
}

interface EventDialogProps {
  /** null: a new event (see `defaults`). */
  occurrence: Occurrence | null
  defaults?: NewEventDefaults
  onClose: () => void
}

export function EventDialog({ occurrence, defaults, onClose }: EventDialogProps) {
  const [scope, setScope] = useState<'one' | 'all' | null>(null)
  if (!occurrence) return <EventForm mode="new" source={null} defaults={defaults} onClose={onClose} />
  if (!occurrence.recurring) return <EventForm mode="event" source={occurrence} onClose={onClose} />
  if (scope === 'one') return <EventForm mode="occurrence" source={occurrence} occurrence={occurrence} onClose={onClose} />
  if (scope === 'all') return <SeriesForm eventId={occurrence.event_id} onClose={onClose} />
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={occurrence.title}
      description="This event repeats. What do you want to change?">
      <div className="flex flex-col gap-2">
        <Button variant="secondary" className="justify-start" onClick={() => setScope('one')}>Only this event</Button>
        <Button variant="secondary" className="justify-start" icon={<RepeatIcon className="h-4 w-4" />} onClick={() => setScope('all')}>
          All events in the series
        </Button>
      </div>
    </Dialog>
  )
}
