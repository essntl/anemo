/**
 * An item's links (what it links to) and backlinks ("Linked from"), grouped by type,
 * from the link index. Links written in the text show as such; links set on a task or
 * event can be added here and removed. A link to something in the trash or deleted for
 * good says so.
 */
import { useState } from 'react'
import { Link } from 'react-router'
import { Link2, Plus, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Lingering } from '@/components/ui/Lingering'
import { toast } from '@/components/ui/toast'
import { LinkPickerDialog } from '@/features/documents/components/LinkPickerDialog'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { allLinks, type LinkOut, type LinkType, useAddLinks, useLinks, useRemoveLink } from './api'
import { GROUP_LABELS, linkState, TYPE_ICONS } from './linkTypes'

function LinkRow({ link, onRemove, onOpen }: { link: LinkOut; onRemove?: () => void; onOpen?: (path: string) => void }) {
  const gone = linkState(link)
  const title = link.title || t('Deleted item')
  const label = (
    <>
      <span className="[&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0 [&>svg]:text-accent">{TYPE_ICONS[link.type]}</span>
      <span className={cn('min-w-0 flex-1 truncate', gone && 'text-muted line-through')}>{title}</span>
      {gone && <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-[11px] text-muted">{gone}</span>}
    </>
  )
  return (
    <li className="group flex items-center gap-1">
      {link.state === 'live' ? (
        <Link to={link.ref} title={link.detail || undefined}
          onClick={(e) => { if (onOpen) { e.preventDefault(); onOpen(link.ref) } }}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-control px-1.5 py-1 text-[13px] hover:bg-surface-hover">
          {label}
        </Link>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-[13px]">{label}</span>
      )}
      {onRemove && link.origin === 'explicit' && (
        <button type="button" onClick={onRemove} title={t('Remove the link')}
          className="rounded-control p-1 text-muted opacity-70 hover:bg-surface-hover hover:text-text group-hover:opacity-100">
          <X className="h-3.5 w-3.5" />
          <span className="sr-only">{t('Remove the link to {title}', { title })}</span>
        </button>
      )}
    </li>
  )
}

function Groups({ links, onRemove, onOpen }: { links: LinkOut[]; onRemove?: (link: LinkOut) => void; onOpen?: (path: string) => void }) {
  const types = [...new Set(links.map((l) => l.type))]
  return (
    <div className="flex flex-col gap-1.5">
      {types.map((type) => (
        <div key={type}>
          {types.length > 1 && <div className="px-1.5 text-[11px] text-subtle">{t(GROUP_LABELS[type])}</div>}
          <ul className="flex flex-col">
            {links.filter((l) => l.type === type).map((l) => (
              <LinkRow key={`${l.type}:${l.id}`} link={l} onOpen={onOpen} onRemove={onRemove ? () => onRemove(l) : undefined} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

const HEADING = 'mb-1 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-muted'

/**
 * `editable`: a task or event, whose links can be added and removed here.
 * `onOpen`: called instead of going to a linked item (a form that saves first).
 */
export function LinksPanel({ type, id, editable, onOpen }: { type: LinkType; id: string; editable?: boolean; onOpen?: (path: string) => void }) {
  const links = useLinks(type, id)
  const owner = type === 'task' || type === 'event' ? type : 'task'
  const add = useAddLinks(owner, id)
  const remove = useRemoveLink(owner, id)
  const [picking, setPicking] = useState(false)
  const fail = (err: unknown) => toast({ message: errorMessage(err) })
  const out = allLinks(links.data?.links)
  const back = allLinks(links.data?.backlinks)
  const canEdit = editable && (type === 'task' || type === 'event')
  if (!links.data || (!canEdit && out.length + back.length === 0)) return null
  return (
    <>
      {(canEdit || out.length > 0) && (
        <section aria-label={t('Links')}>
          <h3 className={HEADING}><Link2 className="h-3.5 w-3.5" /> {t('Links')}</h3>
          <Groups links={out} onOpen={onOpen} onRemove={canEdit ? (l) => remove.mutate(l.ref, { onError: fail }) : undefined} />
          {canEdit && (
            <button type="button" onClick={() => setPicking(true)}
              className="mt-0.5 flex items-center gap-1 rounded-control px-1.5 py-1 text-[12.5px] text-muted hover:bg-surface-hover hover:text-text">
              <Plus className="h-3.5 w-3.5" /> {t('Add a link')}
            </button>
          )}
        </section>
      )}
      {back.length > 0 && (
        <section aria-label={t('Linked from')}>
          <h3 className={HEADING}><Link2 className="h-3.5 w-3.5" /> {t('Linked from')}</h3>
          <Groups links={back} onOpen={onOpen} />
        </section>
      )}
      <Lingering value={picking}>
        {() => (
          <LinkPickerDialog pagesOnly title={t('Link to a document, task, event or chat')}
            onPick={(href) => add.mutate([href], { onError: fail })} onClose={() => setPicking(false)} />
        )}
      </Lingering>
    </>
  )
}
