/** Settings > Appearance: the accent colour and the background tint, with contrast checks. */
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { FieldRow, SettingRow } from '@/components/ui/SettingRow'
import { SliderField } from '@/components/ui/Slider'
import { ACCENT_PRESETS, useThemeStore } from '@/features/settings/theme'
import { msg, t } from '@/lib/i18n'
import { type ContrastWarning, contrastWarnings, DEFAULT_ACCENT, type Resolved } from './apply'
import { ColorField, ColorSwatches, type NamedColor } from './ColorSwatches'

/** The tint presets: soft colours, so the mixed-in surfaces stay calm. */
const TINT_PRESETS: NamedColor[] = [
  { hex: '#7a8cff', name: msg('Periwinkle') },
  { hex: '#ff8fb1', name: msg('Rose') },
  { hex: '#ffb36b', name: msg('Peach') },
  { hex: '#6fd6a8', name: msg('Mint') },
  { hex: '#5ac8e0', name: msg('Sky') },
  { hex: '#b490ff', name: msg('Lavender') },
]
const DEFAULT_TINT = TINT_PRESETS[0].hex

/** ACCENT_PRESETS (theme.ts) with their names. */
const ACCENT_NAMES = [msg('Blue'), msg('Violet'), msg('Pink'), msg('Orange'), msg('Amber'), msg('Green'), msg('Teal'), msg('Graphite')]
const ACCENTS: NamedColor[] = ACCENT_PRESETS.map((hex, i) => ({ hex, name: ACCENT_NAMES[i] }))

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
          <Button size="sm" variant="ghost" className="shrink-0 whitespace-nowrap" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => set({ accent: DEFAULT_ACCENT })}>
            {t('Reset to default')}
          </Button>
        )} />
      <CardBody className="flex flex-col gap-4">
        <ColorSwatches label={t('Accent color')} colors={ACCENTS} value={accent} onChange={(c) => set({ accent: c })} />
        <FieldRow label={t('Custom##color')}>
          <ColorField label={t('Custom accent color')} value={accent} onChange={(c) => set({ accent: c })} />
        </FieldRow>
        <ContrastWarnings kinds={['accent-text', 'accent-page']} />
      </CardBody>
    </Card>
  )
}

export function TintCard() {
  const tint = useThemeStore((s) => s.tint)
  const strength = useThemeStore((s) => s.tint_strength)
  const set = useThemeStore((s) => s.set)
  // While off, the controls keep showing the default (they fold away, see SettingRow).
  const shown = tint ?? DEFAULT_TINT
  return (
    <Card>
      <SettingRow heading title={t('Background tint')} description={t('Mixes a color into the page, panels and cards.')}
        checked={Boolean(tint)} onCheckedChange={(v) => set({ tint: v ? DEFAULT_TINT : null })}>
        <div className="flex flex-col gap-4">
          <ColorSwatches label={t('Tint')} colors={TINT_PRESETS} value={tint} onChange={(c) => set({ tint: c })} />
          <FieldRow label={t('Custom##color')}>
            <ColorField label={t('Custom tint')} value={shown} onChange={(c) => set({ tint: c })} />
          </FieldRow>
          <SliderField label={t('Strength')} min={0} max={100} step={5} value={strength}
            format={(v) => `${v} %`} onChange={(v) => set({ tint_strength: Math.round(v) })} />
          {tint && <ContrastWarnings kinds={['text-surface']} />}
        </div>
      </SettingRow>
    </Card>
  )
}
