/**
 * The field you type a text box into: a textarea laid over the canvas exactly where the
 * text will be drawn, in its font, size and colour. Leaving it (or Esc) keeps the text.
 */
import { useEffect, useRef } from 'react'
import { LIMITS, type TextBox } from '../model'
import { resolveColor, type SketchTheme } from './palette'
import { FONT_FAMILY, LINE_HEIGHT, layoutText } from './text'
import { toScreen, type Viewport } from './viewport'
import { t } from '@/lib/i18n'

/** A text box being typed: an existing one (its id) or a new one. */
export type TextDraft = Omit<TextBox, 'id'> & { id: string | null }

export function TextEditor({ draft, view, theme, onText, onDone }: {
  draft: TextDraft
  view: Viewport
  theme: SketchTheme
  onText: (text: string) => void
  onDone: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const at = toScreen(view, draft.x, draft.y)
  const layout = layoutText({ ...draft, text: draft.text || ' ' })
  const fontSize = draft.size * view.zoom
  return (
    <textarea
      ref={ref}
      aria-label={t('Text')}
      value={draft.text}
      maxLength={LIMITS.textChars}
      spellCheck
      onChange={(e) => onText(e.target.value)}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault()
          e.stopPropagation()
          onDone()
        }
      }}
      // Pointer events on the field are its own (placing the caret), not the canvas's.
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute z-10 m-0 resize-none overflow-hidden border-0 bg-transparent p-0 outline-1 outline-offset-4 outline-accent outline-dashed"
      style={{
        left: at.x,
        top: at.y,
        // Wrapped text keeps its width; free text grows as you type (room for the next letter).
        width: (draft.width ? draft.width : Math.max(layout.width + draft.size, draft.size * 2)) * view.zoom,
        height: layout.height * view.zoom,
        fontFamily: FONT_FAMILY,
        fontSize,
        lineHeight: LINE_HEIGHT,
        color: resolveColor(draft.color, theme),
        caretColor: resolveColor(draft.color, theme),
        whiteSpace: draft.width ? 'pre-wrap' : 'pre',
        overflowWrap: draft.width ? 'break-word' : 'normal',
      }}
    />
  )
}
