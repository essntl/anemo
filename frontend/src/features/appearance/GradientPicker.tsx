/**
 * Settings > Appearance > Background > Animated gradient: the built-in gradients and
 * "Custom" as one radio group of small swatches, and the editor of the custom gradient
 * (2–4 colours, drifting spots or sliding bands at an angle, speed) with a live preview.
 * "Customise …" starts the custom gradient from the chosen preset (with Undo).
 */
import { useRef, type KeyboardEvent } from 'react'
import { Check, Pencil, Plus, X } from 'lucide-react'
import { Segmented } from '@/components/ui/Segmented'
import { FieldRow } from '@/components/ui/SettingRow'
import { SliderField } from '@/components/ui/Slider'
import { toast } from '@/components/ui/toast'
import { cn } from '@/lib/cn'
import { mix } from '@/lib/color'
import { t } from '@/lib/i18n'
import type { Background, CustomGradient } from './apply'
import { ColorField } from './ColorSwatches'
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
  // The chosen preset's colours become the custom gradient's, as a starting point. What
  // was there before comes back with Undo.
  const customise = () => {
    const before = { gradient: background.gradient, custom_gradient: background.custom_gradient }
    onChange({ gradient: 'custom', custom_gradient: { ...background.custom_gradient, colors: colorsOf(background, accent) } })
    toast({
      message: t('Your custom gradient now starts from {name}.', { name: options[current].label }),
      action: { label: t('Undo'), onClick: () => onChange(before) },
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-start gap-2">
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
                    'group-hover:-translate-y-0.5 group-focus-visible:ring-2 group-focus-visible:ring-accent group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-card',
                    chosen
                      ? 'ring-2 ring-accent ring-offset-2 ring-offset-card'
                      : 'group-hover:ring-2 group-hover:ring-border-strong group-hover:ring-offset-2 group-hover:ring-offset-card',
                  )}
                  style={{ background: swatchBackground(o.colors) }}>
                  {chosen && (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-black/45 text-white">
                      <Check className="h-3.5 w-3.5" strokeWidth={3} />
                    </span>
                  )}
                </span>
                <span className={cn('max-w-full truncate text-[12px]', chosen ? 'font-medium text-text' : 'text-muted group-hover:text-text')}>
                  {o.label}
                </span>
              </button>
            )
          })}
        </div>
        {preset && (
          <button type="button" onClick={customise}
            className="inline-flex items-center gap-1.5 rounded-md py-1 text-[12.5px] font-medium text-accent hover:underline pointer-coarse:py-2">
            <Pencil className="h-3.5 w-3.5" /> {t('Customise {name}', { name: options[current].label })}
          </button>
        )}
      </div>
      {!preset && (
        <CustomGradientEditor value={background.custom_gradient} background={background} accent={accent}
          onChange={(patch) => onChange({ custom_gradient: { ...background.custom_gradient, ...patch } })} />
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

  // The same label column as Effects below, so everything in the card lines up.
  return (
    <div className="flex flex-col gap-3" data-testid="custom-gradient-editor">
      <div className="relative h-20 overflow-hidden rounded-control border border-border" aria-hidden>
        <div className="app-gradient" data-style={layer.dataStyle} style={layer.style} />
      </div>
      <FieldRow label={t('Colors')} className="items-start [&>span]:pt-1.5">
        <div role="group" aria-label={t('Colors')} className="flex flex-wrap items-start gap-x-4 gap-y-2">
          {value.colors.map((c, i) => (
            <div key={i} className="flex items-start gap-0.5">
              <ColorField label={t('Color {n}', { n: i + 1 })} value={c} onChange={(hex) => setStop(i, hex)} />
              {value.colors.length > MIN_STOPS && (
                <button type="button" aria-label={t('Remove color {n}', { n: i + 1 })} onClick={() => removeStop(i)}
                  className="flex h-8 w-7 items-center justify-center rounded-md text-subtle hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
          {value.colors.length < MAX_STOPS && (
            <button type="button" onClick={addStop}
              className="flex h-8 items-center gap-1.5 rounded-full border border-dashed border-border-strong px-3 text-[12.5px] text-muted hover:border-accent hover:text-text pointer-coarse:h-10">
              <Plus className="h-3.5 w-3.5" /> {t('Add a color')}
            </button>
          )}
        </div>
      </FieldRow>
      <FieldRow label={t('Style')}>
        <Segmented<CustomGradient['style']> size="sm" label={t('Style')} value={value.style} onChange={(style) => onChange({ style })}
          options={[
            { value: 'drift', label: t('Drifting spots') },
            { value: 'linear', label: t('Sliding bands') },
          ]} />
      </FieldRow>
      <FieldRow label={t('Speed')}>
        <Segmented<CustomGradient['speed']> size="sm" label={t('Speed')} value={value.speed} onChange={(speed) => onChange({ speed })}
          options={[
            { value: 'slow', label: t('Slow') },
            { value: 'normal', label: t('Normal##speed') },
            { value: 'fast', label: t('Fast') },
          ]} />
      </FieldRow>
      {/* Only bands have a direction: the spots sit one near each corner. */}
      {value.style === 'linear' && (
        <SliderField label={t('Angle')} min={0} max={359} step={1} value={value.angle}
          format={(v) => `${v}°`} onChange={(v) => onChange({ angle: Math.round(v) })} />
      )}
    </div>
  )
}
