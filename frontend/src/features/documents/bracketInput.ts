/**
 * Typing `[[` in the rich editor opens the link picker: the two brackets are taken out
 * and the picked link goes in their place. Not inside code (a code block or inline
 * code), where `[[` is just text. Closing the picker without a choice puts them back.
 */
import type { EditorView } from '@tiptap/pm/view'

/** A ProseMirror `handleTextInput`: true when it opened the picker (the `[` isn't typed). */
export function bracketInput(open: () => void) {
  return (view: EditorView, from: number, to: number, text: string): boolean => {
    if (text !== '[' || from < 1) return false
    const $from = view.state.doc.resolve(from)
    if ($from.parent.type.spec.code) return false
    const marks = view.state.storedMarks ?? $from.marks()
    if (marks.some((m) => m.type.spec.code)) return false
    if (view.state.doc.textBetween(from - 1, from) !== '[') return false
    view.dispatch(view.state.tr.delete(from - 1, to))
    open()
    return true
  }
}
