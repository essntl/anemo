/**
 * Every broken link in one place: links to items that were deleted for good, and the
 * document, task or event each is in, so they can be fixed. A link set on a task or
 * event can be removed here; a link written in a text is fixed by editing that text.
 */
import { useState } from 'react'
import { Link } from 'react-router'
import { Unlink, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Dialog } from '@/components/ui/Dialog'
import { NoticeButton } from '@/components/ui/NoticeButton'
import { toast } from '@/components/ui/toast'
import { plural, t } from '@/lib/i18n'
import { type BrokenLink, useBrokenLinks, useRemoveLink } from './api'
import { TYPE_ICONS } from './linkTypes'

function Row({ link, onDone }: { link: BrokenLink; onDone: () => void }) {
  const owner = link.source.type === 'event' ? 'event' : 'task'
  const remove = useRemoveLink(owner, link.source.id)
  return (
    <li className="flex items-center gap-2 border-t border-border py-2 first:border-t-0">
      <Link to={link.source.ref} onClick={onDone}
        className="flex min-w-0 flex-1 items-center gap-2 text-[13px] hover:underline [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0 [&>svg]:text-muted">
        {TYPE_ICONS[link.source.type]}
        <span className="min-w-0 truncate font-medium">{link.source.title}</span>
      </Link>
      <span className="max-w-[45%] shrink-0 truncate font-mono text-[11.5px] text-subtle" title={link.target.ref}>{link.target.ref}</span>
      {link.origin === 'explicit' ? (
        <button type="button" onClick={() => remove.mutate(link.target.ref, { onError: (err) => toast({ message: errorMessage(err) }) })}
          className="rounded-control p-1 text-muted hover:bg-surface-hover hover:text-text" title={t('Remove the link')}>
          <X className="h-3.5 w-3.5" />
          <span className="sr-only">{t('Remove the link from {title}', { title: link.source.title })}</span>
        </button>
      ) : (
        <span className="shrink-0 text-[11.5px] text-muted">{t('in the text')}</span>
      )}
    </li>
  )
}

export function BrokenLinks() {
  const broken = useBrokenLinks()
  const [open, setOpen] = useState(false)
  const list = broken.data ?? []
  if (list.length === 0) return null
  return (
    <>
      <NoticeButton icon={<Unlink />} tone="warning" onClick={() => { setOpen(true); void broken.refetch() }}>
        {plural(list.length, '{n} broken link', '{n} broken links')}
      </NoticeButton>
      <Dialog open={open} onOpenChange={setOpen} className="md:w-[min(94vw,640px)]" title={t('Broken links')}
        description={t('These link to something that was deleted for good. Remove a link, or open the item and change its text.')}>
        <ul className="flex max-h-[60vh] flex-col overflow-auto">
          {list.map((l) => <Row key={`${l.source.type}:${l.source.id}:${l.target.ref}`} link={l} onDone={() => setOpen(false)} />)}
        </ul>
      </Dialog>
    </>
  )
}
