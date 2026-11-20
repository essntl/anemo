/**
 * Where things came from: who made a task, event or document ("Created by the assistant in
 * <chat>", with a link to it), who saved each revision, and the badge of an item synced
 * from an outside system (linking to the original). The server records all of this; the
 * names (a chat's title, an automation's) are looked up when the item is read.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { ExternalLink, RefreshCw, Unlink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { cn } from '@/lib/cn'
import { formatWhen } from '@/lib/format'
import { rich, t } from '@/lib/i18n'
import { type Actor, isSynced, type Synced } from './labels'

const linkClass = 'font-medium text-text underline-offset-2 hover:text-accent hover:underline'

function to(actor: Actor, label: string): ReactNode {
  return actor.url ? <Link to={actor.url} className={linkClass}>{label}</Link> : label
}

/** "Created by …" or "Last changed by …", as a sentence with a link to the chat or automation. */
function actorSentence(actor: Actor, verb: 'created' | 'changed'): ReactNode {
  const created = verb === 'created'
  const name = { name: actor.label }
  switch (actor.kind) {
    case 'chat':
      if (!actor.url) return created ? t('Created by the assistant in a chat that was deleted.') : t('Last changed by the assistant in a chat that was deleted.')
      return created
        ? rich('Created by the assistant in <chat>{name}</chat>.', { chat: (c) => to(actor, c) }, name)
        : rich('Last changed by the assistant in <chat>{name}</chat>.', { chat: (c) => to(actor, c) }, name)
    case 'automation':
      if (!actor.url) return created ? t('Created by an automation that was deleted.') : t('Last changed by an automation that was deleted.')
      return created
        ? rich('Created by the automation <run>{name}</run>.', { run: (c) => to(actor, c) }, name)
        : rich('Last changed by the automation <run>{name}</run>.', { run: (c) => to(actor, c) }, name)
    case 'external':
      return created ? t('Created outside Anemo.') : t('Last changed outside Anemo.')
    default:
      return created ? t('Created by you.') : t('Last changed by you.')
  }
}

/** Who made an item and, when it was someone else, who changed it last. Nothing when unknown. */
export function ActorLine({ created, updated, className }: { created?: Actor | null; updated?: Actor | null; className?: string }) {
  if (!created && !updated) return null
  return (
    <p className={cn('text-[12px] text-muted', className)}>
      {created && actorSentence(created, 'created')}
      {updated && updated.ref !== created?.ref && <> {actorSentence(updated, 'changed')}</>}
    </p>
  )
}

/**
 * The small badge of an item synced from an outside system: the system's name, leading to
 * the original when there is a link. Nothing for ordinary items.
 */
export function SourceBadge({ item, className }: { item: Synced; className?: string }) {
  if (!isSynced(item)) return null
  const name = item.source ?? t('Synced')
  const title = item.source ? t('Synced from {source}', { source: item.source }) : t('Synced from an outside system')
  const look = cn('inline-flex max-w-40 items-center gap-1 rounded-full bg-surface-2 px-1.5 py-px text-[11px] font-medium text-muted', className)
  if (!item.source_url) {
    return <span className={look} title={title}><RefreshCw aria-hidden className="h-2.5 w-2.5 shrink-0" /><span className="truncate">{name}</span></span>
  }
  return (
    // A link to another site: opened in a new tab, on a click only.
    <a href={item.source_url} target="_blank" rel="noopener noreferrer" data-source-link title={t('{title} – open the original', { title })}
      onClick={(e) => e.stopPropagation()} className={cn(look, 'hover:bg-surface-hover hover:text-text')}>
      <RefreshCw aria-hidden className="h-2.5 w-2.5 shrink-0" /><span className="truncate">{name}</span>
      <ExternalLink aria-hidden className="h-2.5 w-2.5 shrink-0" />
    </a>
  )
}

/**
 * In an item's editor: where it is synced from, when, whether you changed it by hand, and a
 * button to detach it from its source (it becomes an ordinary item).
 */
export function SourceDetails({ item, detaching, onDetach }: { item: Synced; detaching?: boolean; onDetach: () => void }) {
  if (!isSynced(item)) return null
  const detach = async () => {
    const ok = await confirmDialog({
      title: t('Detach from its source?'),
      message: t('It becomes an ordinary item. The next sync may add the original again as a new item.'),
      confirmLabel: t('Detach'),
    })
    if (ok) onDetach()
  }
  return (
    <section aria-label={t('Where it comes from')} className="flex flex-col gap-1.5 rounded-control border border-border p-3 text-[12.5px]">
      <div className="flex items-center gap-2">
        <span className="font-medium">{t('Where it comes from')}</span>
        <SourceBadge item={item} />
      </div>
      {item.external_key && <p className="break-all font-mono text-[11.5px] text-muted">{item.external_key}</p>}
      {item.synced_at && <p className="text-muted">{t('Last synced {when}', { when: formatWhen(item.synced_at) })}</p>}
      {item.edited_by_user_at && <p className="text-muted">{t('You changed it by hand {when}', { when: formatWhen(item.edited_by_user_at) })}</p>}
      <Button variant="ghost" size="sm" className="-ml-2 self-start" icon={<Unlink className="h-3.5 w-3.5" />} loading={detaching} onClick={() => void detach()}>
        {t('Detach from source')}
      </Button>
    </section>
  )
}
