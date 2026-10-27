import { AudioLines, AudioWaveform, CloudRain, Activity, Waves } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card } from '@/components/ui/Card'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { cn } from '@/lib/cn'
import { AMBIENT_KINDS, ambientActions, type AmbientKind, useAmbient } from '../player/ambient'

const ICONS: Record<AmbientKind, ReactNode> = {
  rain: <CloudRain />,
  ocean: <Waves />,
  brown: <Activity />,
  pink: <AudioLines />,
  white: <AudioWaveform />,
}

/** Background sound under the music: five generated sounds, on/off and a volume. */
export function AmbientCard() {
  const a = useAmbient()
  return (
    <Card>
      <div className="flex items-center gap-2 px-4 pb-2 pt-4 md:px-5">
        <Waves className="h-4 w-4 text-muted" />
        <h2 className="flex-1 text-[14px] font-semibold">Ambient sound</h2>
        <Switch label="Ambient sound" checked={a.enabled} onChange={ambientActions.toggle} />
      </div>
      <div className="px-4 pb-4 md:px-5">
        <div className="grid grid-cols-5 gap-1.5" role="radiogroup" aria-label="Ambient sound">
          {AMBIENT_KINDS.map((k) => {
            const on = a.enabled && a.kind === k.id
            return (
              <button key={k.id} type="button" role="radio" aria-checked={on} onClick={() => ambientActions.setKind(k.id)}
                className={cn('flex flex-col items-center gap-1 rounded-control py-2.5 text-[12px] font-medium transition-colors [&>svg]:h-5 [&>svg]:w-5',
                  on ? 'bg-accent-soft text-accent ring-1 ring-accent' : 'bg-surface-2 text-muted hover:bg-surface-hover hover:text-text')}>
                {ICONS[k.id]}
                {k.label}
              </button>
            )
          })}
        </div>
        <div className="mt-3 flex items-center gap-2 text-muted">
          <Waves className="h-4 w-4 shrink-0" />
          <Slider label="Ambient volume" className="flex-1" value={a.volume} onChange={ambientActions.setVolume}
            valueText={(v) => `${Math.round(v * 100)}%`} />
        </div>
        <p className="mt-2 text-[12px] text-muted">Generated in your browser. Plays under the music.</p>
      </div>
    </Card>
  )
}
