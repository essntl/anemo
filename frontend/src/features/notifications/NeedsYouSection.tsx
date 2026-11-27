import { type FormEvent, type ReactNode, useState } from 'react'
import { Link } from 'react-router'
import { AlarmClock, Check, Clock, FileCheck2, MessageCircleQuestion, Send, ShieldQuestion, Sparkles } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { toast } from '@/components/ui/toast'
import { useDecide } from '@/features/agents/api'
import type { NeedsRow } from '@/features/home/useNeedsYou'
import { cn } from '@/lib/cn'
import { formatAge } from '@/lib/format'
import { msg, t } from '@/lib/i18n'
import { InboxSection } from './InboxSection'

type Kind = Exclude<NeedsRow['kind'], 'memory'>

const ICON: Record<Kind, ReactNode> = {
  approval: <ShieldQuestion />,
  question: <MessageCircleQuestion />,
  review: <FileCheck2 />,
  automation: <Clock />,
  overdue: <AlarmClock />,
  update: <Sparkles />,
}
const TONE: Record<Kind, string> = {
  approval: 'bg-warning/12 text-warning',
  question: 'bg-accent-soft text-accent',
  review: 'bg-warning/12 text-warning',
  automation: 'bg-error/12 text-error',
  overdue: 'bg-error/12 text-error',
  update: 'bg-accent-soft text-accent',
}
/** The button that opens where it is handled, by kind. */
const OPEN_LABEL: Partial<Record<Kind, string>> = { review: msg('Review'), automation: msg('Open history') }

const fail = (err: unknown) => toast({ message: errorMessage(err) })

/** Allow what an agent asks for, once, or deny it, without opening its chat. */
function DecideButtons({ approval }: { approval: NonNullable<NeedsRow['approval']> }) {
  const decide = useDecide(approval.runId)
  const [choice, setChoice] = useState<'approve' | 'deny' | null>(null)
  const send = (decision: 'approve' | 'deny') => {
    setChoice(decision)
    decide.mutate({ approvalId: approval.id, decision, scope: 'once' }, { onError: fail })
  }
  return (
    <>
      <Button size="sm" variant="secondary" disabled={decide.isPending} loading={decide.isPending && choice === 'deny'} onClick={() => send('deny')}>
        {t('Deny')}
      </Button>
      <Button size="sm" variant="primary" disabled={decide.isPending} loading={decide.isPending && choice === 'approve'} onClick={() => send('approve')}>
        {t('Allow once')}
      </Button>
    </>
  )
}

/** A question an agent asked: pick a suggested answer (or several), or write one. */
function AnswerForm({ question }: { question: NonNullable<NeedsRow['question']> }) {
  const decide = useDecide(question.runId)
  const [own, setOwn] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const answer = (text: string) => decide.mutate({ approvalId: question.id, decision: 'approve', answer: text }, { onError: fail })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (own.trim()) answer(own.trim())
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      {question.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {question.options.map((o) => {
            const on = picked.includes(o)
            return (
              <button key={o} type="button" disabled={decide.isPending} aria-pressed={question.multiple ? on : undefined}
                onClick={() => (question.multiple ? setPicked(on ? picked.filter((p) => p !== o) : [...picked, o]) : answer(o))}
                className={cn('flex min-h-8 items-center gap-1 rounded-full border px-3 text-left text-[12.5px] transition-colors disabled:opacity-50 pointer-coarse:min-h-10',
                  on ? 'border-accent bg-accent text-accent-contrast' : 'border-border-strong bg-surface hover:border-accent hover:text-accent')}>
                {question.multiple && on && <Check aria-hidden className="h-3.5 w-3.5" />}
                {o}
              </button>
            )
          })}
          {question.multiple && (
            <Button size="sm" variant="primary" disabled={picked.length === 0} loading={decide.isPending} onClick={() => answer(picked.join(', '))}>
              {t('Send')}
            </Button>
          )}
        </div>
      )}
      <form onSubmit={submit} className="flex gap-1.5">
        <input value={own} onChange={(e) => setOwn(e.target.value)} aria-label={t('Your answer')}
          placeholder={question.options.length ? t('Or write your own answer…') : t('Your answer…')}
          className="h-8 min-w-0 flex-1 rounded-control border border-border bg-surface px-2.5 text-[13px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft pointer-coarse:h-10" />
        <Button type="submit" size="icon" variant="secondary" className="h-8 w-8 pointer-coarse:h-10 pointer-coarse:w-10" aria-label={t('Send answer')} disabled={!own.trim() || decide.isPending}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      </form>
    </div>
  )
}

/**
 * The top of the Inbox: what waits for the user, each with its main action in place:
 * allow or deny an approval, answer a question, open a review. Every row also links to
 * where it is handled in full. While nothing waits, a one-line "all clear".
 */
export function NeedsYouSection({ rows }: { rows: NeedsRow[] }) {
  return (
    <InboxSection id="needs-you" title={t('Needs you')} count={rows.length} tone="warning">
      {rows.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-3 text-[13px] text-muted">
          <Check aria-hidden className="h-4 w-4 text-success" />{t('Nothing needs you right now.')}
        </p>
      ) : (
        <ul>
          {rows.map((r) => {
            const kind = r.kind as Kind
            return (
              <li key={r.key} className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-border px-4 py-3 last:border-b-0">
                <span aria-hidden className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg [&>svg]:h-4 [&>svg]:w-4', TONE[kind])}>{ICON[kind]}</span>
                <div className="min-w-0 flex-1 basis-48">
                  <Link to={r.to} className="block hover:text-accent">
                    <span className={cn('block text-[13.5px] font-medium', r.question ? 'whitespace-pre-wrap break-words' : 'truncate')}>{r.title}</span>
                  </Link>
                  {(r.detail || r.since) && (
                    <span className="mt-0.5 block truncate text-[12px] text-muted">
                      {[r.detail, r.since && formatAge(r.since)].filter(Boolean).join(' · ')}
                    </span>
                  )}
                  {r.question && <AnswerForm question={r.question} />}
                </div>
                <div className="ml-11 flex shrink-0 items-center gap-1.5 sm:ml-0">
                  {r.approval && <DecideButtons approval={r.approval} />}
                  <Link to={r.to} className="inline-flex h-(--btn-sm-h) shrink-0 items-center rounded-control bg-surface-2 px-3 text-[13px] font-medium hover:bg-surface-hover pointer-coarse:h-10">
                    {r.question ? t('Open chat') : t(OPEN_LABEL[kind] ?? 'Open')}
                  </Link>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </InboxSection>
  )
}
