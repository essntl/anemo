import { useState } from 'react'
import { Link } from 'react-router'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { type LinkTarget, useLinkTargets } from '@/features/links/api'
import { cn } from '@/lib/cn'
import { plural, t } from '@/lib/i18n'
import type { BatchItem } from '../batch'

/** A short batch is listed at once; a longer one waits for a click. */
const SHOWN_AT_ONCE = 3

/** The item's title, linked; its reference instead when the titles could not be loaded. */
function Title({ itemRef, target, failed }: { itemRef: string; target: LinkTarget | undefined; failed: boolean }) {
  if (!target && failed) return <Link to={itemRef} className="font-mono hover:underline">{itemRef}</Link>
  if (!target) return <span className="text-muted">{t('Loading…')}</span>
  if (target.state === 'deleted') return <span className="text-muted">{t('not found')}</span>
  return (
    <Link to={target.ref} className="font-medium hover:underline">
      {target.title || t('(untitled)')}
      {target.state === 'in_trash' && <span className="font-normal text-muted"> {t('(in the trash)')}</span>}
    </Link>
  )
}

/** Every item of the batch the agent asks about: its title and what changes on it. */
export function BatchItems({ items }: { items: BatchItem[] }) {
  const [open, setOpen] = useState(items.length <= SHOWN_AT_ONCE)
  const refs = items.flatMap((i) => (i.ref ? [i.ref] : []))
  const targets = useLinkTargets(open ? refs : [])
  const byRef = new Map((targets.data ?? []).map((target, n) => [refs[n], target]))
  return (
    <div className="mt-2">
      {items.length > SHOWN_AT_ONCE && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
          className="flex items-center gap-1 text-[12px] text-muted hover:text-text">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {open ? t('Hide the items') : plural(items.length, 'Show the {n} item', 'Show all {n} items')}
        </button>
      )}
      {open && (
        <ul aria-label={t('Items in this batch')} className="mt-1 max-h-64 space-y-0.5 overflow-y-auto text-[12.5px]">
          {items.map((i, n) => (
            <li key={`${i.ref ?? 'none'}-${n}`} className="flex flex-wrap gap-x-2">
              {i.ref ? <Title itemRef={i.ref} target={byRef.get(i.ref)} failed={targets.isError} /> : <span className="text-muted">{t('not found')}</span>}
              <span className={cn('text-muted', i.risk === 'dangerous' && 'text-error')}>{i.item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
