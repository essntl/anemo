/**
 * The document's properties, above its text (the editor hides the front matter they
 * are stored in). Each value is a chip; a click edits it. Every change is saved by the
 * server into the file's front matter, as a revision, and the editor picks up the new
 * text.
 *
 * When the front matter can't be read, a warning says why instead: the text is saved
 * as it is, and the properties can be fixed in the Markdown editor.
 */
import { AlertTriangle } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { toast } from '@/components/ui/toast'
import { type PropertyValue, propertiesFor, suggestionsOf, useProperties } from '@/features/properties/api'
import { PropertyChips } from '@/features/properties/PropertyChips'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { type DocumentContent, useSetProperties } from '../api'

interface Props {
  doc: DocumentContent
  projectId: string | null
  /** The version the editor has (sent along, so a change made elsewhere isn't overwritten). */
  baseHash: () => string
  /** Saves what is typed first. */
  flush: () => Promise<boolean>
  /** Above the text (the default), or below it (a phone, while the document has none). */
  edge?: 'top' | 'bottom'
}

/** The document has properties (or front matter that can't be read) to show above its text. */
export const showsProperties = (doc: DocumentContent) =>
  Object.keys(doc.properties ?? {}).length > 0 || !!doc.properties_error

export function PropertiesBar({ doc, projectId, baseHash, flush, edge = 'top' }: Props) {
  const properties = useProperties()
  const set = useSetProperties(doc.id)
  const available = propertiesFor(properties.data ?? [], projectId)
  const values = doc.properties ?? {}

  const change = async (key: string, value: PropertyValue | null): Promise<boolean> => {
    if (!(await flush())) return false
    try {
      await set.mutateAsync({ set: { [key]: value }, baseHash: baseHash() })
      return true
    } catch (err) {
      const near = suggestionsOf(err)
      toast({ message: near.length ? t('{message} Use: {values}', { message: errorMessage(err), values: near.join(', ') }) : errorMessage(err) })
      return false
    }
  }

  if (doc.properties_error) {
    return (
      <div role="status" className="flex items-start gap-2 border-b border-warning/40 bg-warning/8 px-4 py-2 text-[13px]">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">
          {t('The properties at the top of this file can’t be read, so the document has none for now. Its text is saved. Fix them in the Markdown editor:')}{' '}
          <span className="text-muted">{doc.properties_error}</span>
        </span>
      </div>
    )
  }
  if (!properties.data) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5 border-border px-4 py-1.5', edge === 'top' ? 'border-b' : 'border-t')} aria-label={t('Properties')}>
      <PropertyChips available={available} values={values} busy={set.isPending} onChange={change} />
    </div>
  )
}
