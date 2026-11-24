import { Monitor, Moon, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { cn } from '@/lib/cn'
import { BackgroundCard } from '@/features/appearance/BackgroundCard'
import { AccentCard, TintCard } from '@/features/appearance/ColorCards'
import { FontCard } from '@/features/appearance/FontCard'
import { DeviceCard, GlassCard, PreviewCard } from '@/features/appearance/MoreCards'
import { type Density, type ThemeMode, useThemeStore } from '../theme'
import { t } from '@/lib/i18n'

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
          aria-pressed={value === o.value}
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

/**
 * Settings > Appearance. Every change applies to the whole app at once (the app is the
 * preview) and is saved after a short pause; see features/appearance for how.
 */
export function AppearancePage() {
  const { mode, density, set } = useThemeStore()

  return (
    <div className="flex flex-col gap-5">
      <PreviewCard />

      <Card>
        <CardHeader title={t('Theme')} description={t('Light, dark, or follow your system.')} />
        <CardBody>
          <Segmented<ThemeMode>
            value={mode}
            onChange={(m) => set({ mode: m })}
            options={[
              { value: 'light', label: t('Light'), icon: <Sun className="h-4 w-4" /> },
              { value: 'dark', label: t('Dark'), icon: <Moon className="h-4 w-4" /> },
              { value: 'system', label: t('System'), icon: <Monitor className="h-4 w-4" /> },
            ]}
          />
        </CardBody>
      </Card>

      <AccentCard />
      <TintCard />
      <FontCard />
      <BackgroundCard />
      <GlassCard />

      <Card>
        <CardHeader title={t('Density')} description={t('Compact fits more on screen.')} />
        <CardBody>
          <Segmented<Density>
            value={density}
            onChange={(d) => set({ density: d })}
            options={[
              { value: 'comfortable', label: t('Comfortable') },
              { value: 'compact', label: t('Compact') },
            ]}
          />
        </CardBody>
      </Card>

      <DeviceCard />
    </div>
  )
}
