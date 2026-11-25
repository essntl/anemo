import { type ReactNode, useState } from 'react'
import { CalendarDays, CheckSquare, FileText, MessageSquare, PenLine } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Segmented } from '@/components/ui/Segmented'
import { FilesTab } from '@/features/links/FilesTab'
import { useSearch } from '@/features/search/api'
import { STATUS_LABELS, useTasks } from '@/features/tasks/api'
import { documentLink, fileLink, taskLink } from '@/lib/appLinks'
import { formatWhen } from '@/lib/format'
import { t } from '@/lib/i18n'
import { useDocuments } from '../api'

const MAX_SHOWN = 40 // per kind; search narrows it down

function Group({ title, children }: { title: string; children: ReactNode[] }) {
  if (children.length === 0) return null
  return (
    <section>
      <h3 className="bg-surface-2 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{title}</h3>
      {children}
    </section>
  )
}

function Choice({ icon, title, detail, onPick }: { icon: ReactNode; title: string; detail: string; onPick: () => void }) {
  return (
    <button type="button" onClick={onPick}
      className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left hover:bg-surface-hover [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0 [&>svg]:text-muted">
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{title}</span>
        <span className="block truncate text-[11.5px] text-muted">{detail}</span>
      </span>
    </button>
  )
}

/**
 * Pick a document, task, event or chat to link to from the text being written (the
 * toolbar's link button, or typing `[[`). The link is an ordinary Markdown link with the
 * item's canonical reference (its address in the app), the title as its text.
 * `pagesOnly`: without the Files tab (links set on a task or event, `[[`).
 */
export function LinkPickerDialog({ onPick, onPickImage, onClose, pagesOnly, title }: {
  onPick: (href: string, title: string) => void
  /** Documents (not task notes) can show an image from Files in the text. */
  onPickImage?: (path: string, alt: string) => void
  onClose: () => void
  pagesOnly?: boolean
  title?: string
}) {
  const [tab, setTab] = useState<'pages' | 'files'>('pages')
  const documents = useDocuments()
  const tasks = useTasks()
  const [search, setSearch] = useState('')
  // Events and chats are found by the search (there are too many to list them all).
  const found = useSearch(search, { kinds: ['event', 'chat'], limit: 8, mode: 'keyword' })
  const groups = search.trim() ? (found.data?.groups ?? []) : []
  const events = groups.find((g) => g.kind === 'event')?.hits ?? []
  const chats = groups.find((g) => g.kind === 'chat')?.hits ?? []
  const q = search.trim().toLowerCase()
  const matches = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q))
  const pick = (href: string, title: string) => {
    onPick(href, title)
    onClose()
  }

  const shownDocuments = (documents.data?.documents ?? []).filter((d) => matches(d.title, d.path)).slice(0, MAX_SHOWN)
  const shownTasks = (tasks.data ?? [])
    .filter((t) => t.status !== 'cancelled' && matches(t.title))
    // Open tasks first: they are the ones usually meant.
    .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done'))
    .slice(0, MAX_SHOWN)
  const error = documents.error ?? tasks.error
  const loaded = documents.isSuccess && tasks.isSuccess

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={title ?? t('Link to a document, task or file')} className="md:w-[min(92vw,520px)]"
      description={pagesOnly ? t('Type to find events and chats too.') : t('Clicking the link opens it. Selected text becomes the link; otherwise its title is inserted.')}>
      {!pagesOnly && (
        <Segmented label={t('Link to')} kind="tabs" className="mb-3" value={tab} onChange={setTab}
          options={[{ value: 'pages', label: t('Documents, tasks, events and chats') }, { value: 'files', label: t('Files') }]} />
      )}
      {tab === 'files' && !pagesOnly ? (
        <FilesTab onLink={(entry) => pick(fileLink(entry.path), entry.name)}
          onImage={onPickImage ? (entry) => { onPickImage(entry.path, entry.name.replace(/\.[^.]+$/, '')); onClose() } : undefined} />
      ) : (<>
      <Input value={search} autoFocus placeholder={t('Search documents, tasks, events and chats…')} aria-label={t('Search documents, tasks, events and chats')}
        onChange={(e) => setSearch(e.target.value)} />
      <div className="mt-3 max-h-[45dvh] overflow-y-auto rounded-control border border-border">
        {!loaded && !error && <p className="p-4 text-[13px] text-muted">{t('Loading…')}</p>}
        {error && <p className="p-4 text-[13px] text-error">{errorMessage(error)}</p>}
        {loaded && shownDocuments.length + shownTasks.length + events.length + chats.length === 0 && <p className="p-4 text-[13px] text-muted">{t('Nothing matches.')}</p>}
        <Group title={t('Documents')}>
          {shownDocuments.map((d) => (
            <Choice key={d.id} icon={d.kind === 'sketch' ? <PenLine /> : <FileText />} title={d.title} detail={d.path} onPick={() => pick(documentLink(d.id), d.title)} />
          ))}
        </Group>
        <Group title={t('Tasks')}>
          {shownTasks.map((task) => (
            <Choice key={task.id} icon={<CheckSquare />} title={task.title} detail={t(STATUS_LABELS[task.status])} onPick={() => pick(taskLink(task.id), task.title)} />
          ))}
        </Group>
        <Group title={t('Events')}>
          {events.map((hit) => (
            <Choice key={hit.id} icon={<CalendarDays />} title={hit.title} detail={hit.when ? formatWhen(hit.when) : ''} onPick={() => pick(hit.url, hit.title)} />
          ))}
        </Group>
        <Group title={t('Chats')}>
          {chats.map((hit) => (
            <Choice key={hit.id} icon={<MessageSquare />} title={hit.title} detail={hit.when ? formatWhen(hit.when) : ''} onPick={() => pick(hit.url, hit.title)} />
          ))}
        </Group>
      </div>
      </>)}
    </Dialog>
  )
}
