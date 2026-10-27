import { useEffect, useLayoutEffect, useRef } from 'react'

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

/**
 * A single-key shortcut for one page (Space, E, R, …). It does nothing while you type
 * in a field, with Ctrl/⌘/Alt held, or while a dialog or menu is open.
 *
 *   useHotkey((e) => e.key === 'e', () => setEditing((x) => !x))
 */
export function useHotkey(match: (e: KeyboardEvent) => boolean, run: (e: KeyboardEvent) => void, enabled = true) {
  const latest = useRef({ match, run })
  useLayoutEffect(() => {
    latest.current = { match, run }
  })
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return
      if (document.querySelector('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]')) return
      // A focused button or switch handles Space and Enter itself.
      if ((e.key === ' ' || e.key === 'Enter') && e.target instanceof HTMLElement && e.target.closest('button, [role="button"], a, [role="slider"], [role="tab"], [role="radio"]')) return
      if (!latest.current.match(e)) return
      e.preventDefault()
      latest.current.run(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
