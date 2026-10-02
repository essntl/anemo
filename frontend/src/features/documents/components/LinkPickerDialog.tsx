import { type ReactNode, useState } from 'react'
import { CheckSquare, FileText } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { STATUS_LABELS, useTasks } from '@/features/tasks/api'
import { documentLink, taskLink } from '@/lib/appLinks'
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
 * Pick a document or a task to link to from the text being written. The link is an
 * ordinary Markdown link to that page of the app, with the title as its text.
 */
export function LinkPickerDialog({ onPick, onClose }: { onPick: (href: string, title: string) => void; onClose: () => void }) {
  const documents = useDocuments()
  const tasks = useTasks()
  const [search, setSearch] = useState('')
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
    <Dialog open onOpenChange={(open) => !open && onClose()} title="Link to a document or task" className="md:w-[min(92vw,520px)]"
      description="Clicking the link opens it. Selected text becomes the link; otherwise its title is inserted.">
      <Input value={search} autoFocus placeholder="Search documents and tasks…" aria-label="Search documents and tasks"
        onChange={(e) => setSearch(e.target.value)} />
      <div className="mt-3 max-h-[45dvh] overflow-y-auto rounded-control border border-border">
        {!loaded && !error && <p className="p-4 text-[13px] text-muted">Loading…</p>}
        {error && <p className="p-4 text-[13px] text-error">{errorMessage(error)}</p>}
        {loaded && shownDocuments.length + shownTasks.length === 0 && <p className="p-4 text-[13px] text-muted">Nothing matches.</p>}
        <Group title="Documents">
          {shownDocuments.map((d) => (
            <Choice key={d.id} icon={<FileText />} title={d.title} detail={d.path} onPick={() => pick(documentLink(d.id), d.title)} />
          ))}
        </Group>
        <Group title="Tasks">
          {shownTasks.map((t) => (
            <Choice key={t.id} icon={<CheckSquare />} title={t.title} detail={STATUS_LABELS[t.status]} onPick={() => pick(taskLink(t.id), t.title)} />
          ))}
        </Group>
      </div>
    </Dialog>
  )
}
