import { lazy, Suspense, type ComponentProps } from 'react'
import { t } from '@/lib/i18n'

// CodeMirror and its language modes (~650 kB): loaded when a file or a document's
// source is first shown, not with the Files and Documents pages.
const Editor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })))

export function CodeEditor(props: ComponentProps<typeof Editor>) {
  return (
    <Suspense fallback={<p className="p-4 text-muted">{t('Loading…')}</p>}>
      <Editor {...props} />
    </Suspense>
  )
}
