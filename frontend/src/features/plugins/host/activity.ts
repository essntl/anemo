/**
 * What the user and the assistant are doing, for plugin frames, as states only (never any
 * text, so these events need no permission):
 *
 *  - `composer.activity`: the chat message box (`data-plugin-anchor="composer"`) got the
 *    focus, lost it, is being typed in, or the typing paused;
 *  - `assistant.activity`: the chat on screen is thinking, streaming its answer, or idle
 *    (reported by the chat page, lib/assistantActivity.ts).
 *
 * Watched from the document (focus and input events bubble), so the chat code only marks
 * its message box.
 */
import { ANCHOR_ATTRIBUTE } from './layout'

export type ComposerActivity = 'focused' | 'blurred' | 'typing' | 'idle'

/** Typing that pauses this long is "idle" (still focused). */
export const TYPING_IDLE_MS = 1500

const SELECTOR = `[${ANCHOR_ATTRIBUTE}="composer"]`

const inComposer = (target: EventTarget | null): boolean => target instanceof Element && target.closest(SELECTOR) !== null

/** The message box's state now: focused or blurred (typing is only known as it happens). */
export function composerActivity(doc: Document = document): ComposerActivity {
  return inComposer(doc.activeElement) ? 'focused' : 'blurred'
}

/**
 * Calls `fn` whenever the message box's state changes. Returns a function that stops
 * watching. `doc` is for tests.
 */
export function watchComposer(fn: (state: ComposerActivity) => void, doc: Document = document): () => void {
  let state: ComposerActivity = composerActivity(doc)
  let timer = 0
  const set = (next: ComposerActivity) => {
    if (next === state) return
    state = next
    fn(next)
  }
  const onFocusIn = (e: FocusEvent) => {
    // Moving between the box's own controls is not leaving it.
    if (inComposer(e.target) && state === 'blurred') set('focused')
  }
  const onFocusOut = (e: FocusEvent) => {
    if (!inComposer(e.target) || inComposer(e.relatedTarget)) return
    window.clearTimeout(timer)
    set('blurred')
  }
  const onInput = (e: Event) => {
    if (!inComposer(e.target)) return
    set('typing')
    window.clearTimeout(timer)
    timer = window.setTimeout(() => state === 'typing' && set('idle'), TYPING_IDLE_MS)
  }
  doc.addEventListener('focusin', onFocusIn)
  doc.addEventListener('focusout', onFocusOut)
  doc.addEventListener('input', onInput, true)
  return () => {
    window.clearTimeout(timer)
    doc.removeEventListener('focusin', onFocusIn)
    doc.removeEventListener('focusout', onFocusOut)
    doc.removeEventListener('input', onInput, true)
  }
}
