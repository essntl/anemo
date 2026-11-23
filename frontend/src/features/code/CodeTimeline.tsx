/**
 * One job's timeline (built by timeline.ts): text, thinking, tool calls with their
 * results, sub-agents nested in their Task call, raw lines and the notices for what
 * was trimmed or not stored. Everything here comes from the job and is untrusted: it
 * is shown as Markdown (which never loads remote images) or as plain text.
 */
import { type ReactNode, useContext, useState } from 'react'
import {
  Bot, Brain, ChevronRight, FilePen, FileSearch, FileText, Globe, ListTodo, Loader2, type LucideIcon, Search, SquareTerminal, TriangleAlert, Wrench, XCircle,
} from 'lucide-react'
import { Markdown } from '@/components/ui/Markdown'
import { cn } from '@/lib/cn'
import { plural, t } from '@/lib/i18n'
import { JobContext } from './jobContext'
import { TodoChecklist, TrimmedMark } from './parts'
import { logPath } from './threads'
import {
  type FileDiff, type TimelineItem, type ToolCall, EDIT_TOOLS, TASK_TOOLS, diffOf, pathOf, readRange, shellOutput, subjectOf, toTodos,
} from './timeline'

const box = 'overflow-hidden rounded-lg border border-border bg-surface-2'
const pre = 'max-h-80 overflow-auto whitespace-pre-wrap break-words p-2.5 font-mono text-[11.5px] leading-relaxed'

const ICONS: Record<string, LucideIcon> = {
  Bash: SquareTerminal, BashOutput: SquareTerminal, KillShell: SquareTerminal,
  Edit: FilePen, MultiEdit: FilePen, Write: FilePen, NotebookEdit: FilePen,
  Read: FileText, Grep: FileSearch, Glob: FileSearch, WebFetch: Globe, WebSearch: Search,
  TodoWrite: ListTodo, Task: Bot, Agent: Bot,
}

/** Plain text of a tool's result, red when it is an error. */
function ResultText({ call }: { call: ToolCall }) {
  const r = call.result
  if (!r) return null
  if (!r.text && !r.images) return <p className="text-[12px] text-subtle">{t('(no output)')}</p>
  return (
    <div className={box}>
      {r.text && <pre className={cn(pre, r.isError && 'text-error')}>{r.text}</pre>}
      {r.images > 0 && <p className="border-t border-border px-2.5 py-1 text-[11.5px] text-subtle">{plural(r.images, '{n} image (not shown)', '{n} images (not shown)')}</p>}
    </div>
  )
}

function ShellBody({ call }: { call: ToolCall }) {
  const out = shellOutput(call)
  const command = typeof call.input.command === 'string' ? call.input.command : ''
  const description = typeof call.input.description === 'string' ? call.input.description : ''
  return (
    <div className={box}>
      {(description || out?.interrupted || call.result?.isError) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-2.5 py-1.5 text-[11.5px] text-muted">
          {description && <span className="min-w-0 break-words">{description}</span>}
          {out?.interrupted && <span className="text-warning">{t('interrupted')}</span>}
          {call.result?.isError && <span className="font-medium text-error">{t('error')}</span>}
        </div>
      )}
      <pre className={pre}>
        <span className="text-accent">$ </span>
        <span className="font-semibold">{command}</span>
        {'\n'}
        {out ? (
          <>
            {out.stdout}
            {out.stderr && <span className="text-error">{out.stdout && !out.stdout.endsWith('\n') ? '\n' : ''}{out.stderr}</span>}
            {!out.stdout && !out.stderr && call.result && <span className="text-subtle">{call.result.text || t('(no output)')}</span>}
          </>
        ) : call.result ? (
          <span className={cn(call.result.isError ? 'text-error' : undefined)}>{call.result.text || <span className="text-subtle">{t('(no output)')}</span>}</span>
        ) : null}
      </pre>
    </div>
  )
}

export function DiffView({ diff }: { diff: FileDiff }) {
  return (
    <div className={cn(box, 'max-h-96 overflow-auto')}>
      <div className="w-max min-w-full py-1 font-mono text-[11.5px] leading-relaxed">
        {diff.lines.map((line, i) => (
          <div key={i} className={cn('whitespace-pre px-2.5',
            line.kind === 'add' && 'bg-success/12',
            line.kind === 'del' && 'bg-error/12',
            (line.kind === 'hunk' || line.kind === 'note') && 'text-subtle')}>
            <span aria-hidden="true" className={cn('inline-block w-3 select-none', line.kind === 'add' ? 'text-success' : line.kind === 'del' ? 'text-error' : 'text-subtle')}>
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
            </span>
            {line.kind === 'add' && <span className="sr-only">{t('added: ')}</span>}
            {line.kind === 'del' && <span className="sr-only">{t('removed: ')}</span>}
            {line.text || ' '}
          </div>
        ))}
      </div>
    </div>
  )
}

function EditBody({ call }: { call: ToolCall }) {
  const diff = diffOf(call)
  return (
    <>
      {diff ? <DiffView diff={diff} /> : !call.result && <p className="text-[12px] text-subtle">{t('No change to show.')}</p>}
      {call.result?.isError && <ResultText call={call} />}
    </>
  )
}

function ReadBody({ call }: { call: ToolCall }) {
  const range = readRange(call)
  return (
    <>
      {range && (
        <p className="text-[12px] text-muted">
          {range.total ? t('Lines {from}–{to} of {total}', { from: range.from, to: range.to, total: range.total }) : t('Lines {from}–{to}', { from: range.from, to: range.to })}
        </p>
      )}
      <ResultText call={call} />
    </>
  )
}

function WebBody({ call }: { call: ToolCall }) {
  const url = typeof call.input.url === 'string' ? call.input.url : ''
  const prompt = typeof call.input.prompt === 'string' ? call.input.prompt : ''
  return (
    <>
      {/^https?:\/\//i.test(url) && (
        <a href={url} target="_blank" rel="noreferrer noopener" className="block break-all text-[12px] text-accent hover:underline">{url}</a>
      )}
      {prompt && <p className="whitespace-pre-wrap break-words text-[12px] text-muted">{prompt}</p>}
      <ResultText call={call} />
    </>
  )
}

function TaskBody({ call, depth }: { call: ToolCall; depth: number }) {
  const prompt = typeof call.input.prompt === 'string' ? call.input.prompt : ''
  const agent = typeof call.input.subagent_type === 'string' ? call.input.subagent_type : ''
  return (
    <>
      {(agent || prompt) && (
        <div className="text-[12px] text-muted">
          {agent && <span className="mr-1.5 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">{agent}</span>}
          {prompt && <Collapsible text={prompt} />}
        </div>
      )}
      {call.children.length > 0 && (
        <div className="border-l-2 border-border pl-3">
          <Items items={call.children} depth={depth + 1} />
        </div>
      )}
      {call.result && (
        call.result.isError ? <ResultText call={call} /> : call.result.text && (
          <div className="rounded-lg border border-border bg-surface p-2.5 text-[13px]"><Markdown text={call.result.text} /></div>
        )
      )}
    </>
  )
}

/** Long plain text: the first lines, and the rest on request. */
function Collapsible({ text, limit = 400 }: { text: string; limit?: number }) {
  const [all, setAll] = useState(false)
  const long = text.length > limit
  return (
    <span className="whitespace-pre-wrap break-words">
      {long && !all ? `${text.slice(0, limit).trimEnd()}…` : text}
      {long && (
        <button type="button" onClick={() => setAll(!all)} className="ml-1.5 text-accent hover:underline">
          {all ? t('Show less') : t('Show all')}
        </button>
      )}
    </span>
  )
}

function ToolBody({ call, depth }: { call: ToolCall; depth: number }) {
  if (call.name === 'Bash') return <ShellBody call={call} />
  if (EDIT_TOOLS.includes(call.name)) return <EditBody call={call} />
  if (call.name === 'Read') return <ReadBody call={call} />
  if (call.name === 'WebFetch' || call.name === 'WebSearch') return <WebBody call={call} />
  if (TASK_TOOLS.includes(call.name)) return <TaskBody call={call} depth={depth} />
  if (call.name === 'TodoWrite') {
    const todos = toTodos(call.input.todos)
    return todos.length ? <TodoChecklist todos={todos} running={false} /> : null
  }
  if (call.name === 'Grep' || call.name === 'Glob') return <ResultText call={call} />
  // Any other tool: its arguments and its result as text.
  return (
    <>
      {Object.keys(call.input).length > 0 && <pre className={cn(box, pre)}>{JSON.stringify(call.input, null, 2)}</pre>}
      <ResultText call={call} />
    </>
  )
}

function ToolRow({ call, depth }: { call: ToolCall; depth: number }) {
  const view = useContext(JobContext)
  const waiting = !call.result
  const working = waiting && Boolean(view?.running)
  // A sub-agent is open while it works; everything else waits for a tap.
  const [toggled, setOpen] = useState<boolean | null>(null)
  const open = toggled ?? (TASK_TOOLS.includes(call.name) && working)
  const Icon = ICONS[call.name] ?? Wrench
  const subject = subjectOf(call)
  const diff = diffOf(call)
  // The whole subject, which the row cuts short (the command and a link show it themselves).
  const full = ['Bash', 'WebFetch', 'TodoWrite', ...TASK_TOOLS].includes(call.name) ? '' : (pathOf(call) ?? subject)
  const name = call.name || t('Tool result')
  const isError = call.result?.isError
  return (
    <div className="py-0.5">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] hover:bg-surface-hover pointer-coarse:py-2">
        <Icon aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0', isError ? 'text-error' : 'text-muted')} />
        <span className="shrink-0 font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">{subject}</span>
        {diff && (diff.added > 0 || diff.removed > 0) && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span className="text-success">+{diff.added}</span> <span className="text-error">-{diff.removed}</span>
          </span>
        )}
        {working && <Loader2 aria-label={t('Running')} className="h-3.5 w-3.5 shrink-0 animate-spin text-tool-running" />}
        {waiting && !working && <span className="shrink-0 text-[11.5px] text-subtle">{t('no result')}</span>}
        {isError && <XCircle aria-label={t('Error')} className="h-3.5 w-3.5 shrink-0 text-error" />}
        <ChevronRight aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
      </button>
      {call.trimmed && <div className="ml-7"><TrimmedMark /></div>}
      {open && (
        <div className="ml-7 mt-1 min-w-0 space-y-2 text-[12px]">
          {full && <p className="break-all font-mono text-[11.5px] text-muted">{full}</p>}
          <ToolBody call={call} depth={depth} />
        </div>
      )}
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="py-0.5">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!text}
        className="flex items-center gap-2 rounded-lg px-2 py-1 text-[12.5px] text-muted hover:bg-surface-hover disabled:hover:bg-transparent">
        <Brain aria-hidden="true" className="h-3.5 w-3.5" />
        {t('Thinking')}
        {text && <ChevronRight aria-hidden="true" className={cn('h-3.5 w-3.5 text-subtle transition-transform', open && 'rotate-90')} />}
      </button>
      {open && <p className="ml-7 whitespace-pre-wrap break-words text-[12.5px] text-muted">{text}</p>}
    </div>
  )
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="px-2 py-0.5 text-[12px] text-subtle">{children}</p>
}

function Item({ item, depth }: { item: TimelineItem; depth: number }) {
  const view = useContext(JobContext)
  const mark = item.trimmed && item.kind !== 'tool' && item.kind !== 'too_large' ? <TrimmedMark /> : null
  switch (item.kind) {
    case 'init':
      return (
        <Quiet>
          <span className="break-words">
            {[t('Claude Code started'), item.model, item.cwd].filter(Boolean).join(' · ')}
          </span>
        </Quiet>
      )
    case 'system':
      return item.subtype === 'compact_boundary' ? <Quiet>{t('The conversation was compacted.')}</Quiet> : null
    case 'text':
      return <div className="min-w-0 px-2 py-1 text-[14px]"><Markdown text={item.text} />{mark}</div>
    case 'thinking':
      return <Thinking text={item.text} />
    case 'user':
      return <div className="px-2 py-1"><p className="whitespace-pre-wrap break-words rounded-lg bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-muted">{item.text}</p>{mark}</div>
    case 'tool':
      return <ToolRow call={item.call} depth={depth} />
    case 'raw':
      return <div className="px-2 py-0.5"><pre className="whitespace-pre-wrap break-all font-mono text-[11.5px] text-muted">{item.text}</pre>{mark}</div>
    case 'too_large':
      return (
        <div className="flex flex-wrap items-center gap-2 px-2 py-0.5 text-[12px] text-subtle">
          {t('An event too large to store ({type})', { type: item.type })}
          <TrimmedMark />
        </div>
      )
    case 'dropped':
      return (
        <div className="mx-2 my-1 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/12 px-2.5 py-1.5 text-[12px]">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span className="min-w-0 break-words">
            {plural(item.count, '{n} event not stored (over 5 MB).', '{n} events not stored (over 5 MB).')}{' '}
            {view && <span className="break-all text-muted">{t('The full log is on the computer: {path}', { path: logPath(view.job.job_dir) })}</span>}
          </span>
        </div>
      )
    case 'result':
      // Shown as the job's result card (ResultCard), after the timeline.
      return null
    case 'other':
      return <OtherEvent type={item.type} event={item.event} />
  }
}

function OtherEvent({ type, event }: { type: string; event: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="py-0.5">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex items-center gap-2 rounded-lg px-2 py-0.5 text-[12px] text-subtle hover:bg-surface-hover">
        {t('Event: {type}', { type })}
        <ChevronRight aria-hidden="true" className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
      </button>
      {open && <pre className={cn(box, pre, 'ml-7')}>{JSON.stringify(event, null, 2)}</pre>}
    </div>
  )
}

function Items({ items, depth }: { items: TimelineItem[]; depth: number }) {
  return <>{items.map((item) => <Item key={item.key} item={item} depth={depth} />)}</>
}

export function CodeTimeline({ items }: { items: TimelineItem[] }) {
  return <div className="min-w-0"><Items items={items} depth={0} /></div>
}
