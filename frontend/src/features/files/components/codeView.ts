/**
 * Scrolling a CodeMirror editor that is on the page, for code that must not load
 * CodeMirror itself (the Documents page's outline: CodeMirror loads only with the
 * editor, see LazyCodeEditor). CodeEditor.tsx registers the function when it loads; until
 * then there is no editor on the page to scroll.
 */
type ScrollToLine = (editor: HTMLElement, line: number) => boolean

let scroll: ScrollToLine | null = null

export function registerScrollToLine(fn: ScrollToLine): void {
  scroll = fn
}

/** Puts 1-based `line` of the editor at `editor` (its .cm-editor element) at the top and
 * focuses it. False when that is not a loaded CodeMirror editor. */
export function scrollToLine(editor: HTMLElement, line: number): boolean {
  return scroll ? scroll(editor, line) : false
}
