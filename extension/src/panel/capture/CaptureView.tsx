/**
 * Quick capture: save the page or the selection into a document (formatted by Anemo's
 * inline model), or make a task from it. Started here, from the right-click menu, or with
 * a shortcut (Alt+Shift+S saves the selection, Alt+Shift+T makes a task).
 */
import { useEffect, useState } from 'react'
import { BookmarkPlus, Check, ExternalLink, FilePlus, FileText, Globe, Inbox, ListPlus, Loader2, Search, TextSelect, Undo2, X } from 'lucide-react'
import { PageReadError, readPage, SAVE_CHAR_LIMIT, type PageContext } from '@/shared/pageContext'
import { failureMessage } from '@/shared/pageFailure'
import { storage } from '@/shared/storage'
import { Button } from '../ui/Button'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { Field, Input, Textarea } from '../ui/Input'
import { Notice } from '../ui/Notice'
import { Select } from '../ui/Select'
import { cn } from '../lib/cn'
import { useSession } from '../state/useSession'
import { useStored } from '../state/useStored'
import { activeTab } from '../chat/currentTab'
import { RestoreTranslations } from './RestoreTranslations'
import { AlwaysAllow } from '../sites/AlwaysAllow'
import { useCaptureStatus, useCreateTask, useDocuments, useProjects, useStartCapture, useUndoCapture, type Target } from './api'

type Mode = 'page' | 'selection' | 'task'

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Where a saved page or selection goes: the Inbox, a new document, or one you find. */
function DocumentPicker({ value, onChange, allowNew }: { value: string; onChange: (v: string) => void; allowNew: boolean }) {
  const docs = useDocuments()
  const [filter, setFilter] = useState('')
  const shown = (docs.data ?? [])
    .filter((d) => d.path !== 'documents/Inbox.md')
    .filter((d) => !filter || `${d.title} ${d.folder}`.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 100)
  const fixed = [...(allowNew ? [{ id: 'new', title: 'New document', folder: 'Web clips', icon: FilePlus }] : []), { id: 'inbox', title: 'Inbox', folder: 'Saved to the end', icon: Inbox }]
  const row = (id: string, title: string, sub: string, Icon: typeof FileText) => (
    <li key={id} role="option" aria-selected={value === id}>
      <button
        type="button"
        onClick={() => onChange(id)}
        className={cn('flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left', value === id ? 'bg-accent-soft text-accent' : 'hover:bg-surface-hover')}
      >
        <Icon className="h-4 w-4 shrink-0 opacity-80" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{title}</span>
          {sub && <span className="block truncate text-[11.5px] text-muted">{sub}</span>}
        </span>
        {value === id && <Check className="h-4 w-4 shrink-0" />}
      </button>
    </li>
  )
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" />
        <Input placeholder="Find a document" aria-label="Find a document" className="pl-8" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <ul role="listbox" aria-label="Save to" className="max-h-56 overflow-y-auto rounded-control border border-border bg-surface p-1">
        {!filter && fixed.map((f) => row(f.id, f.title, f.folder, f.icon))}
        {shown.map((d) => row(d.id, d.title, d.folder || 'Documents', FileText))}
        {filter && shown.length === 0 && <li className="px-2.5 py-2 text-[12.5px] text-muted">No document matches.</li>}
      </ul>
    </div>
  )
}

function targetOf(choice: string): Target {
  if (choice === 'new') return { mode: 'new' }
  return { mode: 'append', document_id: choice === 'inbox' ? null : choice }
}

function Progress({ id, onAgain }: { id: string; onAgain: () => void }) {
  const status = useCaptureStatus(id)
  const undo = useUndoCapture()
  const { connection } = useSession()
  if (!status || status.status === 'queued' || status.status === 'formatting' || status.status === 'saving') {
    const pieces = status && status.total > 1 ? ` (part ${Math.min(status.done + 1, status.total)} of ${status.total})` : ''
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted" role="status">
        <Loader2 className="h-4 w-4 animate-spin text-accent" /> Formatting with Anemo{pieces}… you can close the panel, it carries on.
      </div>
    )
  }
  if (status.status === 'failed' || !status.result) {
    return <Notice tone="error" title="Not saved">{status.error ?? 'The save failed.'}</Notice>
  }
  const r = status.result
  return (
    <div className="flex flex-col gap-2" role="status" data-testid="capture-done">
      <div className="flex items-center gap-2 text-[13px]">
        <Check className="h-4 w-4 text-success" />
        {undo.isSuccess ? 'Undone.' : <span>Saved to <span className="font-medium">{r.title}</span></span>}
      </div>
      {!r.formatted && !undo.isSuccess && <p className="text-[12px] text-muted">Saved without formatting (the formatting model didn’t answer).</p>}
      {!undo.isSuccess && (
        <div className="flex flex-wrap gap-2">
          <a className="inline-flex h-8 items-center gap-1 rounded-control bg-surface-2 px-3 text-[13px] hover:bg-surface-hover" href={`${connection.serverUrl}/documents/${r.document_id}`} target="_blank" rel="noopener noreferrer">
            View <ExternalLink className="h-3 w-3" />
          </a>
          <Button size="sm" variant="ghost" icon={<Undo2 className="h-3.5 w-3.5" />} loading={undo.isPending} onClick={() => undo.mutate(r.undo)}>
            Undo
          </Button>
        </div>
      )}
      {undo.isError && <p className="text-[12px] text-error">{(undo.error as Error).message}</p>}
      <div>
        <Button size="sm" variant="ghost" onClick={onAgain}>Save something else</Button>
      </div>
    </div>
  )
}

function SaveForm({ mode, page, explanation, onDone }: { mode: 'page' | 'selection'; page: PageContext; explanation?: string; onDone: () => void }) {
  const start = useStartCapture()
  const [format, setFormat] = useState<'markdown' | 'summary'>('markdown')
  const [choice, setChoice] = useState(mode === 'page' ? 'new' : 'inbox')
  const [captureId, setCaptureId] = useState<string | null>(null)
  if (captureId) return <Progress id={captureId} onAgain={onDone} />
  const save = () =>
    start.mutate(
      { page: mode === 'selection' ? { ...page, source: 'selection', content: page.selection } : page, kind: mode, format, target: targetOf(choice), explanation: mode === 'selection' ? explanation : null },
      { onSuccess: setCaptureId },
    )
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-control border border-border bg-bg px-2.5 py-2" data-testid="capture-source">
        <div className="truncate text-[12.5px] font-medium">{page.title || host(page.url)}</div>
        <div className="truncate text-[11.5px] text-muted">{host(page.url)} · {mode === 'selection' ? `${page.selection.split(/\s+/).filter(Boolean).length} words selected` : `${page.wordCount.toLocaleString()} words`}</div>
        {mode === 'selection' && <p className="mt-1.5 line-clamp-4 border-l-2 border-border-strong pl-2 text-[12px] text-muted">{page.selection}</p>}
        {explanation && <p className="mt-1.5 text-[11.5px] text-muted">With Anemo’s explanation underneath.</p>}
      </div>
      {mode === 'page' && (
        <div role="radiogroup" aria-label="Save as" className="flex rounded-control bg-surface-2 p-0.5">
          {(['markdown', 'summary'] as const).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={format === f} onClick={() => setFormat(f)}
              className={cn('flex-1 rounded-[8px] py-1 text-[12.5px] font-medium', format === f ? 'bg-surface shadow-soft' : 'text-muted')}>
              {f === 'markdown' ? 'The page, formatted' : 'A summary'}
            </button>
          ))}
        </div>
      )}
      <Field label="Save to">{() => <DocumentPicker value={choice} onChange={setChoice} allowNew={mode === 'page'} />}</Field>
      {start.isError && <p className="text-[12px] text-error">{(start.error as Error).message}</p>}
      <Button variant="primary" icon={<BookmarkPlus className="h-4 w-4" />} loading={start.isPending} onClick={save}>
        Save
      </Button>
    </div>
  )
}

function TaskForm({ page, onDone }: { page: PageContext; onDone: () => void }) {
  const create = useCreateTask()
  const projects = useProjects()
  const { connection } = useSession()
  const lastProject = useStored('local', 'lastProjectId').value ?? ''
  const firstLine = page.selection.trim().split('\n')[0]?.slice(0, 300) ?? ''
  const [title, setTitle] = useState(firstLine || page.title || host(page.url))
  const [due, setDue] = useState('')
  const [project, setProject] = useState<string | null>(null)
  const quote = page.selection.trim() ? `\n\n> ${page.selection.trim().split('\n').join('\n> ')}` : ''
  const [notes, setNotes] = useState(`From [${page.title || host(page.url)}](${page.url})${quote}`)
  const projectId = project ?? lastProject
  if (create.isSuccess) {
    return (
      <div className="flex flex-col gap-2" role="status" data-testid="task-done">
        <div className="flex items-center gap-2 text-[13px]"><Check className="h-4 w-4 text-success" /> Task created</div>
        <div className="flex gap-2">
          <a className="inline-flex h-8 items-center gap-1 rounded-control bg-surface-2 px-3 text-[13px] hover:bg-surface-hover" href={`${connection.serverUrl}/tasks?task=${create.data.id}`} target="_blank" rel="noopener noreferrer">
            View <ExternalLink className="h-3 w-3" />
          </a>
          <Button size="sm" variant="ghost" onClick={onDone}>Make another</Button>
        </div>
      </div>
    )
  }
  const save = () => {
    void storage.set('local', 'lastProjectId', projectId || null)
    create.mutate({ title: title.trim(), description: notes, due_date: due || null, project_id: projectId || null })
  }
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save() }}>
      <Field label="Title">{(id) => <Input id={id} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} autoFocus />}</Field>
      <Field label="Due date" hint="Leave empty for no due date.">{(id) => <Input id={id} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
      <Field label="Project">
        {(id) => (
          <Select id={id} value={projectId} onValueChange={setProject} options={[{ value: '', label: 'No project' }, ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
        )}
      </Field>
      <Field label="Notes">{(id) => <Textarea id={id} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
      {create.isError && <p className="text-[12px] text-error">{(create.error as Error).message}</p>}
      <Button type="submit" variant="primary" icon={<ListPlus className="h-4 w-4" />} disabled={!title.trim()} loading={create.isPending}>
        Create task
      </Button>
    </form>
  )
}

const ACTIONS: { mode: Mode; label: string; hint: string; icon: typeof FileText }[] = [
  { mode: 'page', label: 'Save page', hint: 'Save page: as a new document, or added to one', icon: FileText },
  { mode: 'selection', label: 'Save selection', hint: 'Save selection: added to the Inbox or a document, with its link', icon: TextSelect },
  { mode: 'task', label: 'Quick task', hint: 'Quick task: from the page or the selection', icon: ListPlus },
]

const TITLES: Record<Mode, string> = { page: 'Save page', selection: 'Save selection', task: 'Quick task' }

export function CaptureView() {
  const { api } = useSession()
  const pending = useStored('session', 'pendingCapture').value ?? null
  const [chosen, setChosen] = useState<{ mode: Mode; page: PageContext; explanation?: string } | null>(null)
  const [reading, setReading] = useState<Mode | null>(null)
  const [problem, setProblem] = useState<{ title: string; body: string } | null>(null)
  // From the right-click menu or a shortcut: that page, until you start over.
  const current = chosen ?? (pending ? { mode: pending.kind, page: pending.page, explanation: pending.explanation } : null)

  const reset = () => {
    setChosen(null)
    setProblem(null)
    if (pending) void storage.set('session', 'pendingCapture', null)
  }

  const begin = async (mode: Mode) => {
    setProblem(null)
    setReading(mode)
    try {
      const tab = await activeTab()
      const page = await readPage(api, tab ?? {}, { limit: SAVE_CHAR_LIMIT })
      if (mode === 'selection' && !page.selection.trim()) {
        setProblem({ title: 'Nothing is selected', body: 'Select some text on the page first.' })
      } else {
        if (pending) void storage.set('session', 'pendingCapture', null)
        setChosen({ mode, page })
      }
    } catch (err) {
      setProblem(err instanceof PageReadError ? failureMessage(err.failure) : { title: 'The page couldn’t be read', body: String(err) })
    } finally {
      setReading(null)
    }
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <RestoreTranslations />
      {current ? (
        <Card>
          <CardHeader title={TITLES[current.mode]} actions={<Button size="sm" variant="ghost" onClick={reset}>Back</Button>} />
          <CardBody className="flex flex-col gap-2">
            {chosen && <AlwaysAllow url={chosen.page.url} />}
            {current.mode === 'task' ? (
              <TaskForm page={current.page} onDone={reset} />
            ) : (
              <SaveForm mode={current.mode} page={current.page} explanation={current.explanation} onDone={reset} />
            )}
          </CardBody>
        </Card>
      ) : (
        <>
          <ThisTab />
          <div className="grid grid-cols-3 gap-2">
            {ACTIONS.map(({ mode, label, hint, icon: Icon }) => (
              <button
                key={mode}
                type="button"
                onClick={() => void begin(mode)}
                disabled={reading !== null}
                title={hint}
                className="group flex flex-col items-center gap-2 rounded-card border border-border bg-card px-2 py-3.5 text-center shadow-soft transition-colors hover:border-accent/50 hover:bg-surface-hover disabled:opacity-60"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent transition-transform group-hover:scale-105">
                  {reading === mode ? <Loader2 className="h-5 w-5 animate-spin" /> : <Icon className="h-5 w-5" />}
                </span>
                <span className="text-[12.5px] font-semibold leading-tight">{label}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {problem && <Notice tone="warning" title={problem.title}>{problem.body}</Notice>}
      {!current && <RecentSaves />}
      {!current && <Shortcuts />}
    </div>
  )
}

/** The tab the actions work on: its title and site, when the extension may read them. */
function ThisTab() {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null)
  useEffect(() => {
    let gone = false
    const update = () => void activeTab().then((t) => !gone && setTab(t ?? null))
    update()
    const onUpdated = (_id: number, change: { url?: string; title?: string; status?: string }) => {
      if (change.url || change.title || change.status === 'complete') update()
    }
    chrome.tabs.onActivated.addListener(update)
    chrome.tabs.onUpdated.addListener(onUpdated)
    return () => {
      gone = true
      chrome.tabs.onActivated.removeListener(update)
      chrome.tabs.onUpdated.removeListener(onUpdated)
    }
  }, [])
  const known = Boolean(tab?.url && /^https?:/.test(tab.url))
  return (
    <div className="flex items-center gap-3 rounded-card border border-border bg-surface px-3.5 py-3" data-testid="capture-tab">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
        <Globe className="h-4.5 w-4.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{known ? tab?.title || host(tab!.url!) : 'The tab in front'}</span>
        <span className="block truncate text-[12px] text-muted">{known ? host(tab!.url!) : 'Save it, a selection from it, or make a task'}</span>
      </span>
    </div>
  )
}

/** What was saved lately in this browser session, with a way to open it. */
function RecentSaves() {
  const { connection } = useSession()
  const captures = Object.values(useStored('session', 'captures').value ?? {}).reverse().slice(0, 5)
  if (captures.length === 0) return null
  return (
    <section aria-label="Recent saves" className="flex flex-col gap-1">
      <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">Recent saves</h3>
      <ul className="flex flex-col gap-0.5">
        {captures.map((c) => (
          <li key={c.id} className="flex items-center gap-2.5 rounded-control px-2 py-1.5 hover:bg-surface-hover">
            {c.status === 'done' ? <Check className="h-4 w-4 shrink-0 text-success" /> : c.status === 'failed' ? <X className="h-4 w-4 shrink-0 text-error" /> : <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium">{c.result?.title ?? (c.status === 'failed' ? 'Not saved' : 'Saving…')}</span>
              <span className="block truncate text-[11.5px] text-muted">{c.status === 'failed' ? (c.error ?? 'The save failed.') : c.result ? c.result.path.replace(/^documents\//, '') : `Part ${Math.min(c.done + 1, Math.max(1, c.total))} of ${Math.max(1, c.total)}`}</span>
            </span>
            {c.result && (
              <a className="shrink-0 rounded-md px-2 py-1 text-[12px] text-accent hover:bg-accent-soft" href={`${connection.serverUrl}/documents/${c.result.document_id}`} target="_blank" rel="noopener noreferrer">
                Open
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Shortcuts() {
  const keys = (k: string) => <kbd className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] text-text">{k}</kbd>
  return (
    <section aria-label="Shortcuts" className="mt-1 flex flex-col gap-1.5 rounded-card border border-dashed border-border px-3.5 py-3 text-[12px] text-muted">
      <div className="flex items-center justify-between gap-2"><span>Save the selection</span>{keys('Alt+Shift+S')}</div>
      <div className="flex items-center justify-between gap-2"><span>Make a task</span>{keys('Alt+Shift+T')}</div>
      <div className="flex items-center justify-between gap-2"><span>Open this panel</span>{keys('Alt+Shift+A')}</div>
      <p className="text-[11.5px] text-subtle">Right-click a page or a selection for more. Keys can be changed at chrome://extensions/shortcuts.</p>
    </section>
  )
}
