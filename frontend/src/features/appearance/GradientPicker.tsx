/**
 * Settings > Appearance > Background > Animated gradient: the built-in gradients and
 * "Custom" as one radio group of small swatches, and the editor of the custom gradient
 * (2–4 colours, drifting spots or sliding bands, angle, speed) with a live preview.
 */
import { useRef, type KeyboardEvent } from 'react'
import { Check, Plus, Wand2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { SliderField } from '@/components/ui/Slider'
import { cn } from '@/lib/cn'
import { mix } from '@/lib/color'
import { t } from '@/lib/i18n'
import type { Background, CustomGradient } from './apply'
import { ColorField } from './ColorCards'
import { colorsOf, GRADIENTS, type GradientId, gradientColors, gradientLayer, swatchBackground } from './gradients'

export const MIN_STOPS = 2
export const MAX_STOPS = 4


interface PickerProps {
  background: Background
  accent: string
  onChange: (patch: Partial<Background>) => void
}

/** The swatches: one tab stop, arrow keys move and choose (a radio group). */
export function GradientPicker({ background, accent, onChange }: PickerProps) {
  const options: { id: GradientId; label: string; colors: string[] }[] = [
    ...GRADIENTS.map((g) => ({ id: g.id, label: t(g.label), colors: gradientColors(g.id, accent) })),
    { id: 'custom', label: t('Custom##gradient'), colors: background.custom_gradient.colors },
  ]
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const current = Math.max(0, options.findIndex((o) => o.id === background.gradient))

  function onKeyDown(e: KeyboardEvent) {
    const last = options.length - 1
    const to: Record<string, number> = {
      ArrowRight: current === last ? 0 : current + 1,
      ArrowDown: current === last ? 0 : current + 1,
      ArrowLeft: current === 0 ? last : current - 1,
      ArrowUp: current === 0 ? last : current - 1,
      Home: 0,
      End: last,
    }
    if (!(e.key in to)) return
    e.preventDefault()
    onChange({ gradient: options[to[e.key]].id })
    refs.current[to[e.key]]?.focus()
  }

  const preset = background.gradient !== 'custom'
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div role="radiogroup" aria-label={t('Gradient')} onKeyDown={onKeyDown} className="flex flex-wrap gap-3">
          {options.map((o, i) => {
            const chosen = i === current
            return (
              <button key={o.id} ref={(el) => { refs.current[i] = el }} type="button" role="radio" aria-checked={chosen}
                tabIndex={chosen ? 0 : -1} onClick={() => onChange({ gradient: o.id })}
                className="group flex w-14 flex-col items-center gap-1.5 rounded-control focus-visible:outline-none">
                <span
                  className={cn(
                    'relative flex h-10 w-14 items-center justify-center rounded-[10px] shadow-soft transition-[transform,box-shadow] duration-150',
                    'group-hover:scale-[1.04] group-focus-visible:ring-2 group-focus-visible:ring-accent group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-card',
                    chosen && 'ring-2 ring-accent ring-offset-2 ring-offset-card',
                  )}
                  style={{ background: swatchBackground(o.colors) }}>
                  {chosen ? (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-black/45 text-white">
                      <Check className="h-3.5 w-3.5" strokeWidth={3} />
                    </span>
                  ) : o.id === 'custom' && (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-black/30 text-white">
                      <Wand2 className="h-3 w-3" />
                    </span>
                  )}
                </span>
                <span className={cn('max-w-full truncate text-[12px]', chosen ? 'font-medium text-text' : 'text-muted')}>{o.label}</span>
              </button>
            )
          })}
        </div>
        {preset && (
          <Button size="sm" variant="ghost" className="-ml-2 md:mb-5 md:ml-0" icon={<Wand2 className="h-3.5 w-3.5" />}
            // The chosen preset's colours become the custom gradient's, as a starting point.
            onClick={() => onChange({ gradient: 'custom', custom_gradient: { ...background.custom_gradient, colors: colorsOf(background, accent) } })}>
            {t('Customise this')}
          </Button>
        )}
      </div>
      {!preset && (
        <CustomGradientEditor value={background.custom_gradient}
          onChange={(patch) => onChange({ custom_gradient: { ...background.custom_gradient, ...patch } })} background={background} accent={accent} />
      )}
    </div>
  )
}

export function CustomGradientEditor({ value, onChange, background, accent }: {
  value: CustomGradient
  onChange: (patch: Partial<CustomGradient>) => void
  background: Background
  accent: string
}) {
  const setStop = (i: number, color: string) => onChange({ colors: value.colors.map((c, j) => (j === i ? color : c)) })
  const removeStop = (i: number) => onChange({ colors: value.colors.filter((_, j) => j !== i) })
  // A new colour starts halfway between the last and the first, so the gradient barely jumps.
  const addStop = () => onChange({ colors: [...value.colors, mix(value.colors[value.colors.length - 1], value.colors[0], 0.5)] })
  // The preview shows the gradient being edited, moving, whatever is chosen behind the app.
  const layer = gradientLayer({ ...background, gradient: 'custom', custom_gradient: value }, accent)

  return (
    <div className="flex flex-col gap-4 rounded-control bg-surface-2/60 p-3 md:p-4" data-testid="custom-gradient-editor">
      <div className="relative h-20 overflow-hidden rounded-control" aria-hidden>
        <div className="app-gradient" data-style={layer.dataStyle} style={layer.style} />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[13px] font-medium">{t('Colors')}</legend>
        {value.colors.map((c, i) => (
          <div key={i} className="flex items-center gap-2">
            <ColorField label={t('Color {n}', { n: i + 1 })} value={c} onChange={(hex) => setStop(i, hex)} />
            {value.colors.length > MIN_STOPS && (
              <Button size="icon" variant="ghost" aria-label={t('Remove color {n}', { n: i + 1 })} onClick={() => removeStop(i)}>
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
        {value.colors.length < MAX_STOPS && (
          <div>
            <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={addStop}>{t('Add a color')}</Button>
          </div>
        )}
      </fieldset>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3 md:grid-cols-[7rem_minmax(0,1fr)]">
          <span className="text-[13px] text-muted">{t('Style')}</span>
          <div>
            <Segmented<CustomGradient['style']> size="sm" label={t('Style')} value={value.style} onChange={(style) => onChange({ style })}
              options={[
                { value: 'drift', label: t('Drifting spots') },
                { value: 'linear', label: t('Sliding bands') },
              ]} />
          </div>
        </div>
        <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3 md:grid-cols-[7rem_minmax(0,1fr)]">
          <span className="text-[13px] text-muted">{t('Speed')}</span>
          <div>
            <Segmented<CustomGradient['speed']> size="sm" label={t('Speed')} value={value.speed} onChange={(speed) => onChange({ speed })}
              options={[
                { value: 'slow', label: t('Slow') },
                { value: 'normal', label: t('Normal##speed') },
                { value: 'fast', label: t('Fast') },
              ]} />
          </div>
        </div>
        <SliderField label={t('Angle')} min={0} max={359} step={1} value={value.angle}
          format={(v) => `${v}°`} onChange={(v) => onChange({ angle: Math.round(v) })} />
      </div>
    </div>
  )
}
