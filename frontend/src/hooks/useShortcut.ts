import { useEffect, useLayoutEffect, useRef } from 'react'
import { matchesShortcut, SHORTCUTS, type ShortcutId } from '@/features/shortcuts/registry'

/** True when the key press is meant for a text field (or anything editable). */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = (target as HTMLInputElement).type
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
}

interface Options {
  enabled?: boolean
  /** Leave the browser's own handling of the key alone (e.g. Ctrl+V, so a paste still happens). */
  keepDefault?: boolean
  /** For shortcuts with Ctrl/⌘: false skips them while you type in a field. Default true. */
  whileTyping?: boolean
}

/**
 * Reacts to a shortcut from the list in features/shortcuts/registry.ts, which also
 * feeds the shortcut sheet. The keys come from that list, never from here.
 *
 * A single key (Space, E, R, Esc, ?) does nothing while you type in a field or while a
 * dialog or menu is open. One with Ctrl/⌘ works anywhere, also while typing (unless
 * `whileTyping: false`).
 *
 *   useShortcut('home.edit', () => setEditing((x) => !x))
 */
export function useShortcut(id: ShortcutId, run: (e: KeyboardEvent) => void, options: Options | boolean = {}) {
  const { enabled = true, keepDefault = false, whileTyping = true } = typeof options === 'boolean' ? { enabled: options } : options
  const latest = useRef({ run, keepDefault, whileTyping })
  useLayoutEffect(() => {
    latest.current = { run, keepDefault, whileTyping }
  })
  useEffect(() => {
    if (!enabled) return
    const s = SHORTCUTS[id]
    const withModifier = s.keys.some((k) => 'mod' in k && k.mod)
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !matchesShortcut(s, e)) return
      if (withModifier) {
        if (!latest.current.whileTyping && isTyping(e.target)) return
      } else {
        if (isTyping(e.target)) return
        if (document.querySelector('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]')) return
        // A focused button or switch handles Space and Enter itself.
        if ((e.key === ' ' || e.key === 'Enter') && e.target instanceof HTMLElement && e.target.closest('button, [role="button"], a, [role="slider"], [role="tab"], [role="radio"]')) return
      }
      if (!latest.current.keepDefault) e.preventDefault()
      latest.current.run(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, id])
}
