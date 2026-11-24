/**
 * Settings > Appearance: preset colours as one radio group of round swatches (accent,
 * tint), and ColorField, a colour of your own (the browser's picker plus a hex field).
 * One look for every colour choice on the page: the chosen swatch has a ring and a
 * check; the group is one tab stop and the arrow keys move through it.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import { Check } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { contrastText } from '@/features/settings/theme'
import { cn } from '@/lib/cn'
import { isHex } from '@/lib/color'
import { t } from '@/lib/i18n'

export interface NamedColor {
  hex: string
  /** Shown as a tooltip and read out, e.g. "Blue" (a msg() key). */
  name: string
}

export function ColorSwatches({ label, colors, value, onChange }: {
  /** The group's name, e.g. "Accent color". */
  label: string
  colors: NamedColor[]
  /** The current colour; when it isn't a preset (a custom one), no swatch is chosen. */
  value: string | null
  onChange: (hex: string) => void
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const current = colors.findIndex((c) => c.hex === value)

  function onKeyDown(e: KeyboardEvent) {
    const last = colors.length - 1
    const from = current === -1 ? 0 : current
    const to: Record<string, number> = {
      ArrowRight: from === last ? 0 : from + 1,
      ArrowDown: from === last ? 0 : from + 1,
      ArrowLeft: from === 0 ? last : from - 1,
      ArrowUp: from === 0 ? last : from - 1,
      Home: 0,
      End: last,
    }
    if (!(e.key in to)) return
    e.preventDefault()
    onChange(colors[to[e.key]].hex)
    refs.current[to[e.key]]?.focus()
  }

  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="flex flex-wrap gap-2">
      {colors.map((c, i) => {
        const chosen = i === current
        return (
          <button key={c.hex} ref={(el) => { refs.current[i] = el }} type="button" role="radio" aria-checked={chosen}
            aria-label={t(c.name)} title={t(c.name)}
            // One tab stop: the chosen swatch, or the first while none is.
            tabIndex={chosen || (current === -1 && i === 0) ? 0 : -1}
            onClick={() => onChange(c.hex)}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full shadow-soft transition-[transform,box-shadow] duration-150 hover:scale-110',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-card',
              chosen && 'ring-2 ring-text/70 ring-offset-2 ring-offset-card',
            )}
            style={{ background: c.hex }}>
            {chosen && <Check className="h-4 w-4" strokeWidth={3} style={{ color: contrastText(c.hex) }} />}
          </button>
        )
      })}
    </div>
  )
}

/**
 * A colour of your own: a round swatch that opens the browser's colour picker
 * (keyboard-usable), plus a hex field. The field reports a value only once it is a whole
 * hex colour; while it isn't, it says so, and leaving the field puts the last good
 * colour back.
 */
export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const [text, setText] = useState(value)
  // A new value from outside (a preset, Reset): show it in the field too.
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    setText(value)
  }
  const valid = isHex(text.startsWith('#') ? text : `#${text}`)
  const errorId = `${label.replace(/\W+/g, '-')}-error`
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input type="color" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}
          className="color-input h-8 w-8 shrink-0 pointer-coarse:h-10 pointer-coarse:w-10" />
        <Input aria-label={t('{label} (hex)', { label })} value={text} spellCheck={false} maxLength={7}
          aria-invalid={!valid || undefined} aria-describedby={valid ? undefined : errorId}
          onChange={(e) => {
            const next = e.target.value.trim()
            setText(next)
            const hex = next.startsWith('#') ? next : `#${next}`
            if (isHex(hex)) onChange(hex.toLowerCase())
          }}
          onBlur={() => !valid && setText(value)}
          className={cn('h-8 w-24 font-mono text-[13px] pointer-coarse:h-10', !valid && 'border-error focus:border-error')} />
      </div>
      {!valid && <span id={errorId} className="text-[12px] text-error">{t('Use a color like #1a2b3c')}</span>}
    </div>
  )
}
