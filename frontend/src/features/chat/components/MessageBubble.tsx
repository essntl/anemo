import { useState, type ReactNode } from 'react'
import { AlertCircle, Brain, Check, ChevronLeft, ChevronRight, Copy, Download, GitBranch, MessageCircleReply, Pencil, RotateCcw } from 'lucide-react'
import type { Schemas } from '@/api/client'
import { DiagramFixContext, type DiagramProblem } from '@/components/diagrams/context'
import { Markdown } from '@/components/ui/Markdown'
import { cn } from '@/lib/cn'
import { rich, t } from '@/lib/i18n'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Input'
import { ZoomableImage } from '@/components/ui/ZoomableImage'
import { SkillIcon } from '@/features/skills/icons'
import { AttachmentChip } from './AttachmentChip'
import { ReferenceChip } from './ChatReference'
import { PageChip } from './PageChip'
import type { QuestionMark } from '../api'
import { splitAtQuestions } from '../questionMarks'

type AttachmentSummary = Schemas['AttachmentSummary']
type ReferenceSummary = Schemas['ReferenceSummary']
type SkillSummary = Schemas['SkillSummary']
type PageSummary = Schemas['PageSummary']

interface UserProps {
  text: string
  attachments?: AttachmentSummary[]
  /** Other chats that were attached to this message as context. */
  references?: ReferenceSummary[]
  /** The skill the message was started with (/study ...). */
  skill?: SkillSummary | null
  /** A web page attached by the browser extension, with where to load its text from. */
  page?: { summary: PageSummary; conversationId: string; messageId: string } | null
  /** Set on the last message you sent (when nothing is running): change it and have it answered again. */
  onEdit?: (text: string) => void
}

export function UserBubble({ text, attachments = [], references = [], skill, page, onEdit }: UserProps) {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft !== null) {
    const save = () => {
      if (draft.trim() && draft.trim() !== text) onEdit?.(draft.trim())
      setDraft(null)
    }
    return (
      <div className="flex flex-col items-end gap-2">
        <Textarea value={draft} autoFocus rows={Math.min(8, draft.split('\n').length + 1)} aria-label={t('Edit your message')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setDraft(null)}
          className="w-full max-w-[80%] text-[14.5px]" />
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>{t('Cancel')}</Button>
          <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={save}>{t('Send again')}</Button>
        </div>
      </div>
    )
  }
  return (
    <div className="group flex flex-col items-end gap-2">
      {page && <PageChip page={page.summary} conversationId={page.conversationId} messageId={page.messageId} />}
      {references.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-2">
          {references.map((r) => <ReferenceChip key={r.conversation_id} chat={{ id: r.conversation_id, title: r.title }} link />)}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-2">
          {attachments.map((a) =>
            a.kind === 'image' ? (
              <ZoomableImage key={a.id} src={`/api/attachments/${a.id}/content`} alt={a.filename}
                className="max-h-48 max-w-64 rounded-xl border border-border object-cover" />
            ) : (
              <a key={a.id} href={`/api/attachments/${a.id}/content`} download={a.filename}>
                <AttachmentChip name={a.filename} size={a.size} kind={a.kind} />
              </a>
            ),
          )}
        </div>
      )}
      {/* A message can be just files (or a page): then no empty bubble under them. */}
      {(text || skill) && (
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[14.5px]">
        {skill && (
          <span className="mr-2 inline-flex items-center gap-1 align-[-2px] font-medium text-accent" title={t('Answered with the /{slug} skill', { slug: skill.slug })}>
            <SkillIcon name={skill.icon} className="h-[15px] w-[15px]" />
            {skill.name}
          </span>
        )}
        {text}
      </div>
      )}
      {onEdit && (
        <button type="button" onClick={() => setDraft(text)}
          className="-mr-1.5 -mt-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-subtle opacity-70 transition-opacity hover:bg-surface-hover hover:text-text group-hover:opacity-100">
          <Pencil className="h-3.5 w-3.5" /> {t('Edit')}
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
        {active ? <span className="shimmer">{t('Reasoning…')}</span> : t('Reasoning')}
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

/** Where the agent stopped to ask you something: a quiet line between the text it
 *  wrote before and after your answer. */
function QuestionDivider({ mark }: { mark: QuestionMark }) {
  const answer = mark.answer ?? t('You left it to the agent')
  // The user's and the agent's words are put in by hand, so a “<” in them is never read as a part of the text.
  const said = (c: string) => <span className="text-muted">{c.replace('{answer}', () => mark.answer ?? '')}</span>
  const asked = (c: string) => <span className="max-sm:hidden">{c.replace('{question}', () => mark.question)}</span>
  return (
    <div className="my-3 flex items-center gap-2 text-[12px] text-subtle" title={`${mark.question}\n→ ${answer}`}>
      <span className="h-px w-4 shrink-0 bg-border" />
      <MessageCircleReply className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {mark.answer !== null
          ? (mark.question ? rich('You answered <a>“{answer}”</a><q> to “{question}”</q>', { a: said, q: asked }) : rich('You answered <a>“{answer}”</a>', { a: said }))
          : (mark.question ? rich('You left it to the agent<q> to “{question}”</q>', { q: asked }) : answer)}
      </span>
      <span className="h-px min-w-4 flex-1 bg-border" />
    </div>
  )
}

/** Answers to the same message (Regenerate adds one): which one is shown, and the
 *  arrows to go through them. */
export interface VersionNav {
  index: number
  count: number
  onSelect: (index: number) => void
}

function VersionArrows({ index, count, onSelect }: VersionNav) {
  return (
    <span className="mr-1 flex shrink-0 items-center" aria-label={t('Version {index} of {count}', { index: index + 1, count })}>
      <button type="button" disabled={index === 0} onClick={() => onSelect(index - 1)} title={t('Previous version')}
        aria-label={t('Previous version')} className={cn(FOOTER_BUTTON, 'disabled:opacity-40 disabled:hover:bg-transparent')}>
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="min-w-[2.25rem] text-center tabular-nums">{index + 1}/{count}</span>
      <button type="button" disabled={index === count - 1} onClick={() => onSelect(index + 1)} title={t('Next version')}
        aria-label={t('Next version')} className={cn(FOOTER_BUTTON, 'disabled:opacity-40 disabled:hover:bg-transparent')}>
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </span>
  )
}

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
  /** Agent runs: where the agent asked you something, shown in the text. */
  questions?: QuestionMark[]
  /** Set when the message was answered more than once. */
  versions?: VersionNav
  /** Files the agent attached to this answer, to download. */
  files?: AttachmentSummary[]
  /** Asks the model to correct a diagram in this answer that can't be drawn. */
  onFixDiagram?: (problem: DiagramProblem) => void
}

/** Files the agent made for you, under its answer. */
function AnswerFiles({ files }: { files: AttachmentSummary[] }) {
  return (
    <div className={cn('mt-3 flex flex-wrap gap-2', ANSWER_INSET)} aria-label={t('Files from the agent')}>
      {files.map((a) =>
        a.kind === 'image' ? (
          <div key={a.id} className="relative">
            <ZoomableImage src={`/api/attachments/${a.id}/content`} alt={a.filename}
              className="max-h-48 max-w-64 rounded-xl border border-border object-cover" />
            <a href={`/api/attachments/${a.id}/content`} download={a.filename} title={t('Download {name}', { name: a.filename })}
              aria-label={t('Download {name}', { name: a.filename })}
              className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-lg bg-surface/90 text-muted shadow-sm hover:text-text">
              <Download className="h-3.5 w-3.5" />
            </a>
          </div>
        ) : (
          <a key={a.id} href={`/api/attachments/${a.id}/content`} download={a.filename}>
            <AttachmentChip name={a.filename} size={a.size} kind={a.kind} download />
          </a>
        ),
      )}
    </div>
  )
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
  questions,
  versions,
  files,
  onFixDiagram,
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
        <div className={cn('flex h-7 items-center gap-2.5 text-[13px]', ANSWER_INSET)} role="status" aria-label={t('Waiting for the model')}>
          <span className="wave flex items-center gap-1" aria-hidden>
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
          <span className="shimmer font-medium">{t('Thinking')}</span>
        </div>
      )}
      {(text || Boolean(questions?.length)) && (
        <DiagramFixContext.Provider value={live ? null : (onFixDiagram ?? null)}>
          <div className={ANSWER_INSET}>
            {splitAtQuestions(text, questions).map((part, i) =>
              part.kind === 'question'
                ? <QuestionDivider key={i} mark={part.mark} />
                : part.text && <Markdown key={i} text={part.text} streaming={live} />,
            )}
            {live && !suspended && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-accent align-middle" />}
          </div>
        </DiagramFixContext.Provider>
      )}

      {files && files.length > 0 && <AnswerFiles files={files} />}

      {status === 'failed' && (
        <div className="mt-2 flex items-start gap-2 rounded-xl bg-error/10 px-3 py-2 text-[13px] text-error">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error ?? t('Something went wrong.')}</span>
        </div>
      )}

      {/* 1px less in than the text above: the smaller, fainter letters otherwise look indented. */}
      {!live && (
        <div className="mt-2 flex items-center gap-1 pl-[3px] text-[12px] text-subtle opacity-70 transition-opacity group-hover:opacity-100">
          {versions && versions.count > 1 && <VersionArrows {...versions} />}
          {status === 'cancelled' && <span className="mr-2 shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-muted">{t('Stopped')}</span>}
          {/* On a phone the buttons are just icons, so the model's name has the room. */}
          {modelLabel && <span className="mr-2 min-w-0 flex-1 break-words leading-snug md:flex-none" title={modelLabel}>{modelLabel}</span>}
          {text && (
            <button type="button" onClick={copy} title={copied ? t('Copied') : t('Copy')} className={FOOTER_BUTTON}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span className="max-md:sr-only">{copied ? t('Copied') : t('Copy')}</span>
            </button>
          )}
          {onRegenerate && (
            <button type="button" onClick={onRegenerate} title={status === 'failed' ? t('Retry') : t('Regenerate')} className={FOOTER_BUTTON}>
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="max-md:sr-only">{status === 'failed' ? t('Retry') : t('Regenerate')}</span>
            </button>
          )}
          {onBranch && status !== 'failed' && (
            <button type="button" onClick={onBranch} title={t('Continue from here in a new chat')} className={FOOTER_BUTTON}>
              <GitBranch className="h-3.5 w-3.5" />
              <span className="max-md:sr-only">{t('Branch')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
