import { useMemo } from 'react'
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { yaml } from '@codemirror/lang-yaml'

/** Pick syntax highlighting from the file extension. */
function languageFor(path: string): Extension[] {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return [javascript({ jsx: true })]
  if (['ts', 'tsx'].includes(ext)) return [javascript({ jsx: true, typescript: true })]
  if (ext === 'py') return [python()]
  if (['md', 'markdown'].includes(ext)) return [markdown()]
  if (['json', 'jsonl'].includes(ext)) return [json()]
  if (['html', 'htm', 'vue', 'svelte'].includes(ext)) return [html()]
  if (['css', 'scss'].includes(ext)) return [css()]
  if (['yml', 'yaml'].includes(ext)) return [yaml()]
  return []
}

// Editor colors come from the app's theme tokens, so it follows light/dark and the accent.
const tokenTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--card)', color: 'var(--text)', height: '100%', fontSize: '13px' },
  '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: 'var(--text-subtle)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--accent) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection) !important',
  },
  '&.cm-focused': { outline: 'none' },
})

export function CodeEditor({
  path,
  value,
  onChange,
}: {
  path: string
  value: string
  onChange: (value: string) => void
}) {
  const extensions = useMemo(() => [...languageFor(path), tokenTheme, EditorView.lineWrapping], [path])
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme="none"
      height="100%"
      className="h-full"
      basicSetup={{ foldGutter: false, highlightActiveLineGutter: true }}
    />
  )
}
