import { Check, Monitor, Moon, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { cn } from '@/lib/cn'
import { ACCENT_PRESETS, type Density, type ThemeMode, useThemeStore } from '../theme'

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; icon?: ReactNode }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex rounded-control bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors',
            value === o.value ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function AppearancePage() {
  const { mode, accent, density, set } = useThemeStore()

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="Theme" description="Light, dark, or follow your system." />
        <CardBody>
          <Segmented<ThemeMode>
            value={mode}
            onChange={(m) => set({ mode: m })}
            options={[
              { value: 'light', label: 'Light', icon: <Sun className="h-4 w-4" /> },
              { value: 'dark', label: 'Dark', icon: <Moon className="h-4 w-4" /> },
              { value: 'system', label: 'System', icon: <Monitor className="h-4 w-4" /> },
            ]}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Accent color" description="Used for highlights, buttons and selection." />
        <CardBody className="flex flex-wrap items-center gap-3">
          {ACCENT_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Accent ${c}`}
              onClick={() => set({ accent: c })}
              className="flex h-9 w-9 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition-transform hover:scale-105"
              style={{ background: c, boxShadow: accent === c ? `0 0 0 2px ${c}` : undefined }}
            >
              {accent === c && <Check className="h-4 w-4 text-accent-contrast" />}
            </button>
          ))}
          <label className="ml-2 flex items-center gap-2 text-[13px] text-muted">
            Custom
            <input
              type="color"
              value={accent}
              onChange={(e) => set({ accent: e.target.value })}
              className="h-9 w-12 cursor-pointer rounded-control border border-border bg-transparent"
            />
          </label>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Density" description="Compact fits more on screen." />
        <CardBody>
          <Segmented<Density>
            value={density}
            onChange={(d) => set({ density: d })}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </CardBody>
      </Card>
    </div>
  )
}
