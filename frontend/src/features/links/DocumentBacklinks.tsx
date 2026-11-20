import { Link } from 'react-router'
import { Link2 } from 'lucide-react'
import { t } from '@/lib/i18n'
import { allLinks, useLinks } from './api'
import { TYPE_ICONS } from './linkTypes'

/** A slim bar under a document: the documents, tasks and events that link to it. */
export function DocumentBacklinks({ documentId }: { documentId: string }) {
  const links = useLinks('document', documentId)
  const back = allLinks(links.data?.backlinks)
  if (back.length === 0) return null
  const chip = 'flex max-w-56 items-center gap-1 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 hover:border-border-strong [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0 [&>svg]:text-accent'
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border px-4 py-2 text-[12.5px]" aria-label={t('Linked from')}>
      <span className="flex items-center gap-1 text-muted"><Link2 className="h-3.5 w-3.5" /> {t('Linked from')}</span>
      {back.map((l) => (
        <Link key={`${l.type}:${l.id}`} to={l.ref} title={l.detail || undefined} className={chip}>
          {TYPE_ICONS[l.type]}<span className="truncate">{l.title}</span>
        </Link>
      ))}
    </div>
  )
}
