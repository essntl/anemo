import { useState, type ReactNode } from 'react'
import { Minus, Plus } from 'lucide-react'
import { errorMessage, type Schemas } from '@/api/client'
import { Select } from '@/components/ui/Select'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { cn } from '@/lib/cn'
import { useSaveSection, useSettings } from '@/features/settings/api'
import { playSound } from '../sounds'

type Focus = Schemas['FocusSettings']

const PRESETS = [
  { name: 'Classic', focus: 25, short: 5, long: 15 },
  { name: 'Deep', focus: 50, short: 10, long: 20 },
  { name: 'Flow', focus: 90, short: 20, long: 30 },
]

/** A number with − and + buttons; the number can be typed too. */
function Stepper({ value, onChange, min, max, label, unit }: {
  value: number; onChange: (v: number) => void; min: number; max: number; label: string; unit?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (raw: string) => {
    const n = Math.round(Number(raw))
    if (Number.isFinite(n) && raw.trim() !== '') onChange(Math.min(max, Math.max(min, n)))
    setDraft(null)
  }
  const step = 'flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-text disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-10'
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-control bg-surface-2 p-0.5">
      <button type="button" className={step} aria-label={`Less: ${label}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        <Minus className="h-4 w-4" />
      </button>
      <label className="flex w-16 items-baseline justify-center gap-0.5">
        <input type="number" inputMode="numeric" aria-label={label} min={min} max={max} value={draft ?? value}
          onChange={(e) => setDraft(e.target.value)} onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="w-9 bg-transparent text-center text-[15px] font-semibold tabular-nums focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
        {unit && <span className="text-[12px] text-muted">{unit}</span>}
      </label>
      <button type="button" className={step} aria-label={`More: ${label}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        <Plus className="h-4 w-4" />
      </button>
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium">{label}</div>
        {hint && <div className="text-[12px] text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

/** Timer settings. Changes are saved at once and apply on every device. */
export function TimerSettingsForm() {
  const settings = useSettings()
  const save = useSaveSection('focus')
  const s = settings.data?.focus
  if (!s) return null
  const set = (patch: Partial<Focus>) => save.mutate({ ...s, ...patch })
  const preset = PRESETS.find((p) => p.focus === s.focus_minutes && p.short === s.short_break_minutes && p.long === s.long_break_minutes)?.name

  return (
    <div>
      <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Presets">
        {PRESETS.map((p) => (
          <button key={p.name} type="button" aria-pressed={preset === p.name}
            onClick={() => set({ focus_minutes: p.focus, short_break_minutes: p.short, long_break_minutes: p.long })}
            className={cn('rounded-control border px-2.5 py-1.5 text-left transition-colors',
              preset === p.name ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2 hover:bg-surface-hover')}>
            <div className={cn('text-[13px] font-semibold', preset === p.name && 'text-accent')}>{p.name}</div>
            <div className="text-[11.5px] text-muted tabular-nums">{p.focus} / {p.short} / {p.long}</div>
          </button>
        ))}
      </div>
      <div className="mt-2 divide-y divide-border">
        <Row label="Focus">
          <Stepper label="Focus minutes" unit="min" min={1} max={240} value={s.focus_minutes} onChange={(v) => set({ focus_minutes: v })} />
        </Row>
        <Row label="Short break">
          <Stepper label="Short break minutes" unit="min" min={1} max={60} value={s.short_break_minutes} onChange={(v) => set({ short_break_minutes: v })} />
        </Row>
        <Row label="Long break">
          <Stepper label="Long break minutes" unit="min" min={1} max={120} value={s.long_break_minutes} onChange={(v) => set({ long_break_minutes: v })} />
        </Row>
        <Row label="Long break after" hint="Focus sessions in a cycle">
          <Stepper label="Sessions before a long break" min={1} max={12} value={s.rounds_before_long_break} onChange={(v) => set({ rounds_before_long_break: v })} />
        </Row>
        <Row label="Start breaks by themselves">
          <Switch label="Start breaks by themselves" checked={s.auto_start_breaks} onChange={(v) => set({ auto_start_breaks: v })} />
        </Row>
        <Row label="Start focus by itself" hint="When a break ends">
          <Switch label="Start focus by itself" checked={s.auto_start_focus} onChange={(v) => set({ auto_start_focus: v })} />
        </Row>
        <Row label="Sound">
          <Select variant="pill" aria-label="Sound" value={s.chime}
            onValueChange={(v) => { set({ chime: v as Focus['chime'] }); playSound('chime', v as Focus['chime'], s.chime_volume) }}
            options={[{ value: 'bell', label: 'Bell' }, { value: 'soft', label: 'Soft' }, { value: 'none', label: 'None' }]} />
        </Row>
        {s.chime !== 'none' && (
          <Row label="Volume">
            <Slider label="Sound volume" className="w-36" value={s.chime_volume} commit="release"
              valueText={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => { set({ chime_volume: v }); playSound('chime', s.chime, v) }} />
          </Row>
        )}
        <Row label="Countdown in the tab title">
          <Switch label="Countdown in the tab title" checked={s.title_countdown} onChange={(v) => set({ title_countdown: v })} />
        </Row>
        <Row label="Daily goal" hint="Shown in This week">
          <Stepper label="Daily goal in minutes" unit="min" min={0} max={1440} value={s.daily_goal_minutes} onChange={(v) => set({ daily_goal_minutes: v })} />
        </Row>
        <Row label="Keep in Notifications" hint="Also list finished phases under Notifications">
          <Switch label="Keep finished phases in Notifications" checked={s.save_to_notifications} onChange={(v) => set({ save_to_notifications: v })} />
        </Row>
      </div>
      {save.isError && <p className="mt-2 text-[12.5px] text-error">{errorMessage(save.error)}</p>}
    </div>
  )
}
