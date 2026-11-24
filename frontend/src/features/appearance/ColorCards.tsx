/** Settings > Appearance: the accent colour and the background tint, with contrast checks. */
import { useState } from 'react'
import { AlertTriangle, Check, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { ACCENT_PRESETS, useThemeStore } from '@/features/settings/theme'
import { isHex } from '@/lib/color'
import { t } from '@/lib/i18n'
import { type ContrastWarning, contrastWarnings, DEFAULT_ACCENT, type Resolved } from './apply'

const TINT_PRESETS = ['#7a8cff', '#ff8fb1', '#ffb36b', '#6fd6a8', '#5ac8e0', '#b490ff']
const DEFAULT_TINT = TINT_PRESETS[0]

/**
 * A colour as a swatch (the browser's colour picker, keyboard-usable) plus a hex field.
 * The field only reports a value once it is a whole hex colour.
 */
export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const [text, setText] = useState(value)
  // A new value from outside (a preset, Reset): show it in the field too.
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    setText(value)
  }
  const valid = isHex(text)
  return (
    <div className="flex items-center gap-2">
      <input type="color" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}
        className="h-9 w-12 shrink-0 rounded-control border border-border bg-transparent" />
      <Input aria-label={t('{label} (hex)', { label })} value={text} spellCheck={false} maxLength={7}
        aria-invalid={!valid || undefined}
        onChange={(e) => {
          const next = e.target.value.trim()
          setText(next)
          const hex = next.startsWith('#') ? next : `#${next}`
          if (isHex(hex)) onChange(hex.toLowerCase())
        }}
        className={`w-28 font-mono ${valid ? '' : 'border-error'}`} />
    </div>
  )
}

function warningText(w: ContrastWarning): string {
  const ratio = w.ratio.toFixed(1)
  switch (w.kind) {
    case 'accent-text':
      return t('Text on buttons in this color is hard to read ({ratio}:1, needs {needed}:1).', { ratio, needed: w.needed })
    case 'accent-page':
      return t('Links and outlines in this color are hard to see on the page ({ratio}:1, needs {needed}:1).', { ratio, needed: w.needed })
    default:
      return t('Grey text on this tint is hard to read ({ratio}:1, needs {needed}:1). Lower the strength.', { ratio, needed: w.needed })
  }
}

const MODE_LABEL: Record<Resolved, () => string> = { light: () => t('Light'), dark: () => t('Dark') }

/** The contrast problems in light and in dark mode, as a list of warnings. */
export function ContrastWarnings({ kinds }: { kinds: ContrastWarning['kind'][] }) {
  const appearance = useThemeStore()
  const rows = (['light', 'dark'] as const).flatMap((mode) =>
    contrastWarnings(appearance, mode).filter((w) => kinds.includes(w.kind)).map((w) => ({ mode, w })),
  )
  if (rows.length === 0) return null
  return (
    <ul role="status" className="mt-3 flex flex-col gap-1.5">
      {rows.map(({ mode, w }) => (
        <li key={`${mode}-${w.kind}`} className="flex items-start gap-2 text-[12.5px] text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span><span className="font-medium">{MODE_LABEL[mode]()}:</span> {warningText(w)}</span>
        </li>
      ))}
    </ul>
  )
}

export function AccentCard() {
  const accent = useThemeStore((s) => s.accent)
  const set = useThemeStore((s) => s.set)
  return (
    <Card>
      <CardHeader title={t('Accent color')} description={t('Used for highlights, buttons and selection. Hover shades and the text on it follow automatically.')}
        actions={accent !== DEFAULT_ACCENT && (
          <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => set({ accent: DEFAULT_ACCENT })}>
            {t('Reset to default')}
          </Button>
        )} />
      <CardBody>
        <div className="flex flex-wrap items-center gap-3">
          {ACCENT_PRESETS.map((c) => (
            <button key={c} type="button" aria-label={t('Accent {color}', { color: c })} aria-pressed={accent === c}
              onClick={() => set({ accent: c })}
              className="flex h-9 w-9 items-center justify-center rounded-full transition-transform hover:scale-105"
              style={{ background: c, boxShadow: accent === c ? `0 0 0 2px var(--card), 0 0 0 4px ${c}` : undefined }}>
              {accent === c && <Check className="h-4 w-4 text-accent-contrast" />}
            </button>
          ))}
          <div className="ml-1">
            <ColorField label={t('Custom accent color')} value={accent} onChange={(c) => set({ accent: c })} />
          </div>
        </div>
        <ContrastWarnings kinds={['accent-text', 'accent-page']} />
      </CardBody>
    </Card>
  )
}

export function TintCard() {
  const tint = useThemeStore((s) => s.tint)
  const strength = useThemeStore((s) => s.tint_strength)
  const set = useThemeStore((s) => s.set)
  const on = Boolean(tint)
  return (
    <Card>
      <CardHeader title={t('Background tint')} description={t('Mixes a color into the page, panels and cards.')}
        actions={<Switch label={t('Background tint')} checked={on} onChange={(v) => set({ tint: v ? DEFAULT_TINT : null })} />} />
      {on && tint && (
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            {TINT_PRESETS.map((c) => (
              <button key={c} type="button" aria-label={t('Tint {color}', { color: c })} aria-pressed={tint === c}
                onClick={() => set({ tint: c })}
                className="h-8 w-8 rounded-full transition-transform hover:scale-105"
                style={{ background: c, boxShadow: tint === c ? `0 0 0 2px var(--card), 0 0 0 4px ${c}` : undefined }} />
            ))}
            <ColorField label={t('Custom tint')} value={tint} onChange={(c) => set({ tint: c })} />
          </div>
          <div className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-[13px] text-muted">{t('Strength')}</span>
            <Slider label={t('Tint strength')} min={0} max={100} step={5} value={strength}
              valueText={(v) => `${Math.round(v)} %`} onChange={(v) => set({ tint_strength: Math.round(v) })} className="flex-1" />
            <span className="w-10 text-right text-[12.5px] tabular-nums text-muted">{strength} %</span>
          </div>
          <ContrastWarnings kinds={['text-surface']} />
        </CardBody>
      )}
    </Card>
  )
}
