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
  /** A single key that also works while you type and while a dialog is open (Esc while dictating). */
  anywhere?: boolean
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
  const { enabled = true, keepDefault = false, whileTyping = true, anywhere = false } = typeof options === 'boolean' ? { enabled: options } : options
  const latest = useRef({ run, keepDefault, whileTyping, anywhere })
  useLayoutEffect(() => {
    latest.current = { run, keepDefault, whileTyping, anywhere }
  })
  useEffect(() => {
    if (!enabled) return
    const s = SHORTCUTS[id]
    const withModifier = s.keys.some((k) => 'mod' in k && k.mod)
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !matchesShortcut(s, e)) return
      if (withModifier) {
        if (!latest.current.whileTyping && isTyping(e.target)) return
      } else if (!latest.current.anywhere) {
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

/** Two presses of a key within this many milliseconds are a double press. */
export const DOUBLE_PRESS_MS = 500

type PressEvent = Pick<KeyboardEvent, 'type' | 'key' | 'repeat' | 'timeStamp' | 'getModifierState'>

/**
 * Counts the presses of a key and says when one is the second of a quick pair. Caps Lock
 * is different: macOS sends only a key-down when it turns on and only a key-up when it
 * turns off, so there a press is a change of its on/off state, seen on either event.
 */
export function doublePressDetector(windowMs = DOUBLE_PRESS_MS): (e: PressEvent) => boolean {
  let last = -Infinity
  let lock: boolean | null = null
  return (e) => {
    if (e.repeat) return false
    let pressed: boolean
    if (e.key === 'CapsLock') {
      const on = e.getModifierState('CapsLock')
      // The first event seen is a press; after that, only a change of state is.
      pressed = lock === null || on !== lock
      lock = on
    } else {
      pressed = e.type === 'keydown'
    }
    if (!pressed) return false
    if (e.timeStamp - last <= windowMs) {
      last = -Infinity // a third press starts a new pair
      return true
    }
    last = e.timeStamp
    return false
  }
}

/**
 * Reacts to a key pressed twice in quick succession (Caps Lock twice: dictation). Works
 * everywhere, also while you type and in dialogs; the key itself still does what it does.
 */
export function useDoublePress(id: ShortcutId, run: () => void, enabled = true) {
  const latest = useRef(run)
  useLayoutEffect(() => {
    latest.current = run
  })
  useEffect(() => {
    if (!enabled) return
    const s = SHORTCUTS[id]
    const detect = doublePressDetector()
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(s, e) && detect(e)) latest.current()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
    }
  }, [enabled, id])
}
