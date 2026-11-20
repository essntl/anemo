/** A plain notes box where typing `[[` links to a document, task, event or chat. */
import { useRef, useState } from 'react'
import { Textarea } from '@/components/ui/Input'
import { Lingering } from '@/components/ui/Lingering'
import { LinkPickerDialog } from '@/features/documents/components/LinkPickerDialog'
import { t } from '@/lib/i18n'
import { bracketsTyped, insertLink, markdownLink } from './brackets'

export function NotesWithLinks({ value, onChange, rows = 3, maxLength }: { value: string; onChange: (value: string) => void; rows?: number; maxLength?: number }) {
  const box = useRef<HTMLTextAreaElement>(null)
  const [at, setAt] = useState<number | null>(null)
  const pick = (href: string, title: string) => {
    if (at === null) return
    const done = insertLink(value, at, markdownLink(title, href))
    onChange(done.text)
    window.setTimeout(() => {
      box.current?.focus()
      box.current?.setSelectionRange(done.cursor, done.cursor)
    })
  }
  return (
    <>
      <Textarea ref={box} rows={rows} value={value} maxLength={maxLength}
        onChange={(e) => {
          const next = e.target.value
          const found = bracketsTyped(value, next, e.target.selectionStart)
          onChange(next)
          if (found >= 0) setAt(found)
        }} />
      <Lingering value={at !== null}>
        {() => (
          <LinkPickerDialog pagesOnly title={t('Link to a document, task, event or chat')}
            onPick={pick} onClose={() => setAt(null)} />
        )}
      </Lingering>
    </>
  )
}
