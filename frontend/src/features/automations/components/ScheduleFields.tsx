/** The "when does it run?" part of the automation dialog, with a preview of the next runs. */
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { formatUpcoming } from '@/lib/format'
import type { SchedulePreview } from '../api'
import { type Frequency, FREQUENCY_OPTIONS, type ScheduleForm, WEEKDAYS } from '../scheduleForm'

const TIMED: Frequency[] = ['daily', 'weekdays', 'weekly', 'monthly', 'once']

interface Props {
  form: ScheduleForm
  onChange: (form: ScheduleForm) => void
  /** The time zone the times are meant in. */
  tz: string
  /** What the server says about the schedule as it is now (see useSchedulePreview). */
  preview: SchedulePreview
}

export function ScheduleFields({ form, onChange, tz, preview }: Props) {
  const set = (patch: Partial<ScheduleForm>) => onChange({ ...form, ...patch })

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Runs">
          <Select value={form.frequency} options={FREQUENCY_OPTIONS} onValueChange={(v) => set({ frequency: v as Frequency })} />
        </Field>
        {form.frequency === 'weekly' && (
          <Field label="On">
            <Select value={String(form.weekday)} onValueChange={(v) => set({ weekday: Number(v) })}
              options={[1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), label: WEEKDAYS[d] }))} />
          </Field>
        )}
        {form.frequency === 'monthly' && (
          <Field label="On day" hint="1 to 28, so it exists in every month">
            <Input type="number" min={1} max={28} value={form.monthDay}
              onChange={(e) => set({ monthDay: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })} />
          </Field>
        )}
        {form.frequency === 'once' && (
          <Field label="On">
            <Input type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} />
          </Field>
        )}
        {TIMED.includes(form.frequency) && (
          <Field label="At">
            <Input type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} />
          </Field>
        )}
        {(form.frequency === 'hours' || form.frequency === 'minutes') && (
          <Field label={form.frequency === 'hours' ? 'Every … hours' : 'Every … minutes'}
            hint={form.frequency === 'minutes' ? 'At least 5' : undefined}>
            <Input type="number" min={form.frequency === 'minutes' ? 5 : 1} max={form.frequency === 'minutes' ? 720 : 168}
              value={form.every} onChange={(e) => set({ every: Number(e.target.value) || 0 })} />
          </Field>
        )}
        {form.frequency === 'cron' && (
          <Field label="Cron expression" hint="minute hour day month weekday, e.g. 30 7 * * 1,3,5">
            <Input value={form.cron} className="font-mono" spellCheck={false} onChange={(e) => set({ cron: e.target.value })} />
          </Field>
        )}
      </div>
      <div className="rounded-control bg-surface-2 px-3 py-2 text-[12.5px]" aria-live="polite">
        {preview.problem ? (
          <span className="text-error">{preview.problem}</span>
        ) : preview.text ? (
          <>
            <span className="font-medium">{preview.text}</span>
            {preview.nextRuns.length > 0 ? (
              <span className="text-muted"> · next: {preview.nextRuns.slice(0, 3).map((t) => formatUpcoming(t)).join(', ')}</span>
            ) : (
              <span className="text-error"> · that time has already passed</span>
            )}
            <div className="mt-0.5 text-muted">Times are in {tz}.</div>
          </>
        ) : (
          <span className="text-muted">Checking the schedule…</span>
        )}
      </div>
    </div>
  )
}
