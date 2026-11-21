/**
 * Putting dictated text into a text field as if it had been typed: React's onChange and
 * the document editor see it, and Ctrl+Z takes it out again.
 */

export type TextTarget = HTMLTextAreaElement | HTMLInputElement | HTMLElement

const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', 'tel', ''])

/** The text field `el` is or is inside of, if any: a textarea, a text input or an editable area. */
export function textTarget(el: Element | null): TextTarget | null {
  if (!(el instanceof HTMLElement)) return null
  if (el instanceof HTMLTextAreaElement) return el.disabled || el.readOnly ? null : el
  if (el instanceof HTMLInputElement) {
    return TEXT_INPUTS.has(el.type) && !el.disabled && !el.readOnly ? el : null
  }
  if (el.isContentEditable) {
    // The editable root, so the caret saved on it is the editor's own.
    let root: HTMLElement = el
    while (root.parentElement?.isContentEditable) root = root.parentElement
    return root
  }
  return null
}

function isField(el: TextTarget): el is HTMLTextAreaElement | HTMLInputElement {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
}

/** A space before the text when it would otherwise run into the word before the caret. */
export function joinText(before: string, text: string): string {
  if (!before || /\s$/.test(before) || /^[\s.,;:!?)]/.test(text)) return text
  return ` ${text}`
}

/** Sets a field's value so React notices (its own setter would be skipped by React's value tracking). */
function setNativeValue(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * Inserts `text` at the caret of `el` (or at its end when it never had one), focusing it.
 * A one-line input gets the lines joined with spaces.
 */
export function insertText(el: TextTarget, raw: string): void {
  let text = raw.trim()
  if (!text) return
  el.focus()
  if (isField(el)) {
    if (el instanceof HTMLInputElement) text = text.replace(/\s*\n+\s*/g, ' ')
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    const piece = joinText(el.value.slice(0, start), text)
    el.setSelectionRange(start, end)
    // execCommand keeps the browser's undo; where it is missing (tests, old browsers), set the value.
    if (!document.execCommand?.('insertText', false, piece)) {
      setNativeValue(el, el.value.slice(0, start) + piece + el.value.slice(end))
      el.setSelectionRange(start + piece.length, start + piece.length)
    }
    return
  }
  // An editable area (the document editor): the editor handles the insert itself.
  const sel = window.getSelection()
  if (sel && !el.contains(sel.anchorNode)) {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  const before = sel?.anchorNode?.textContent?.slice(0, sel.anchorOffset) ?? ''
  document.execCommand?.('insertText', false, joinText(before, text))
}
