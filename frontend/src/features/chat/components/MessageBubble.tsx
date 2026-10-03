import { useState, type ReactNode } from 'react'
import { AlertCircle, Brain, Check, ChevronRight, Copy, GitBranch, Pencil, RotateCcw } from 'lucide-react'
import type { Schemas } from '@/api/client'
import { Markdown } from '@/components/ui/Markdown'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Input'
import { AttachmentChip } from './AttachmentChip'
import { ReferenceChip } from './ChatReference'

type AttachmentSummary = Schemas['AttachmentSummary']
type ReferenceSummary = Schemas['ReferenceSummary']

interface UserProps {
  text: string
  attachments?: AttachmentSummary[]
  /** Other chats that were attached to this message as context. */
  references?: ReferenceSummary[]
  /** Set on the last message you sent (when nothing is running): change it and have it answered again. */
  onEdit?: (text: string) => void
}

export function UserBubble({ text, attachments = [], references = [], onEdit }: UserProps) {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft !== null) {
    const save = () => {
      if (draft.trim() && draft.trim() !== text) onEdit?.(draft.trim())
      setDraft(null)
    }
    return (
      <div className="flex flex-col items-end gap-2">
        <Textarea value={draft} autoFocus rows={Math.min(8, draft.split('\n').length + 1)} aria-label="Edit your message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setDraft(null)}
          className="w-full max-w-[80%] text-[14.5px]" />
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={save}>Send again</Button>
        </div>
      </div>
    )
  }
  return (
    <div className="group flex flex-col items-end gap-2">
      {references.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-2">
          {references.map((r) => <ReferenceChip key={r.conversation_id} chat={{ id: r.conversation_id, title: r.title }} link />)}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-2">
          {attachments.map((a) =>
            a.kind === 'image' ? (
              <a key={a.id} href={`/api/attachments/${a.id}/content`} target="_blank" rel="noreferrer">
                <img
                  src={`/api/attachments/${a.id}/content`}
                  alt={a.filename}
                  className="max-h-48 max-w-64 rounded-xl border border-border object-cover"
                />
              </a>
            ) : (
              <a key={a.id} href={`/api/attachments/${a.id}/content`} download={a.filename}>
                <AttachmentChip name={a.filename} size={a.size} />
              </a>
            ),
          )}
        </div>
      )}
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[14.5px]">
        {text}
      </div>
      {onEdit && (
        <button type="button" onClick={() => setDraft(text)}
          className="-mr-1.5 -mt-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-subtle opacity-70 transition-opacity hover:bg-surface-hover hover:text-text group-hover:opacity-100">
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
      )}
    </div>
  )
}

/** Provider-exposed reasoning only; nothing is invented when a model does not share it. */
function ReasoningPanel({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false)
  const expanded = open || active
  return (
    <div className="mb-3 rounded-xl border border-border bg-surface-2/60">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-[12.5px] font-medium text-muted hover:text-text"
      >
        <Brain className={cn('h-3.5 w-3.5', active && 'animate-pulse text-accent')} />
        {active ? <span className="shimmer">Reasoning…</span> : 'Reasoning'}
        <ChevronRight className={cn('ml-auto h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')} />
      </button>
      {expanded && (
        <div className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-border px-3 py-2 text-[12.5px] leading-relaxed text-muted">
          {text}
        </div>
      )}
    </div>
  )
}

// relative: the label hidden on phones (sr-only, absolute) stays inside the button
// instead of stretching the page.
/** How far an answer's text sits in from the edge of the bars above it: a little, so the
 *  text doesn't look pushed against the edge, but less than the bars' own padding. */
const ANSWER_INSET = 'px-1'

const FOOTER_BUTTON =
  'relative flex shrink-0 items-center justify-center gap-1 rounded-md px-1.5 py-1 hover:bg-surface-hover hover:text-text max-md:h-9 max-md:w-9 max-md:px-0'

interface AssistantProps {
  text: string
  reasoning?: string | null
  status: string // streaming | complete | cancelled | failed | queued | running
  error?: string | null
  modelLabel?: string | null
  notice?: string | null
  onRegenerate?: () => void
  /** Start a new chat from a copy of this one up to this answer. */
  onBranch?: () => void
  /** Agent runs: plan and tool calls, shown above the answer. */
  activity?: ReactNode
}

export function AssistantMessage({
  text,
  reasoning,
  status,
  error,
  modelLabel,
  notice,
  onRegenerate,
  onBranch,
  activity,
}: AssistantProps) {
  const [copied, setCopied] = useState(false)
  const live = ['streaming', 'queued', 'running', 'waiting_approval', 'waiting_subagent', 'paused'].includes(status)
  const suspended = status === 'waiting_approval' || status === 'paused'
  // An agent run says so in its own bar ("Working…"); a plain answer gets this line.
  const waiting = live && !text && !reasoning && !suspended && !activity

  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="group">
      {notice && <div className={cn('mb-2 text-[12px] text-warning', ANSWER_INSET)}>{notice}</div>}
      {activity}
      {reasoning && <ReasoningPanel text={reasoning} active={live && !text} />}
      {waiting && (
        <div className={cn('flex h-7 items-center gap-2.5 text-[13px]', ANSWER_INSET)} role="status" aria-label="Waiting for the model">
          <span className="wave flex items-center gap-1" aria-hidden>
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
          <span className="shimmer font-medium">Thinking</span>
        </div>
      )}
      {text && (
        <div className={ANSWER_INSET}>
          <Markdown text={text} />
          {live && !suspended && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-accent align-middle" />}
        </div>
      )}

      {status === 'failed' && (
        <div className="mt-2 flex items-start gap-2 rounded-xl bg-error/10 px-3 py-2 text-[13px] text-error">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error ?? 'Something went wrong.'}</span>
        </div>
      )}

      {/* 1px less in than the text above: the smaller, fainter letters otherwise look indented. */}
      {!live && (
        <div className="mt-2 flex items-center gap-1 pl-[3px] text-[12px] text-subtle opacity-70 transition-opacity group-hover:opacity-100">
          {status === 'cancelled' && <span className="mr-2 shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-muted">Stopped</span>}
          {/* On a phone the buttons are just icons, so the model's name has the room. */}
          {modelLabel && <span className="mr-2 min-w-0 flex-1 break-words leading-snug md:flex-none" title={modelLabel}>{modelLabel}</span>}
          {text && (
            <button type="button" onClick={copy} title={copied ? 'Copied' : 'Copy'} className={FOOTER_BUTTON}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span className="max-md:sr-only">{copied ? 'Copied' : 'Copy'}</span>
            </button>
          )}
          {onRegenerate && (
            <button type="button" onClick={onRegenerate} title={status === 'failed' ? 'Retry' : 'Regenerate'} className={FOOTER_BUTTON}>
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="max-md:sr-only">{status === 'failed' ? 'Retry' : 'Regenerate'}</span>
            </button>
          )}
          {onBranch && status !== 'failed' && (
            <button type="button" onClick={onBranch} title="Continue from here in a new chat" className={FOOTER_BUTTON}>
              <GitBranch className="h-3.5 w-3.5" />
              <span className="max-md:sr-only">Branch</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
