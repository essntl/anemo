import { type FormEvent, useState } from 'react'
import { Check, MessageCircleQuestion, Send } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'
import { type ToolCallView, useDecide } from '../api'
import { questionOf } from '../question'

/**
 * The agent asks something and waits. Pick a suggested answer (or several, when it
 * allows that), or write your own. Typing in the chat's message
 * box answers too (see ConversationPage).
 */
export function QuestionCard({ runId, call }: { runId: string; call: ToolCallView }) {
  const decide = useDecide(runId)
  const { question, options, multiple } = questionOf(call)
  const [picked, setPicked] = useState<string[]>([])
  const [own, setOwn] = useState('')
  const approvalId = call.approval!.id

  const answer = (text: string) => decide.mutate({ approvalId, decision: 'approve', answer: text })
  const sendOwn = (e: FormEvent) => {
    e.preventDefault()
    if (own.trim()) answer(own.trim())
  }

  return (
    <div className="mt-2 rounded-xl border border-accent/40 bg-accent-soft/40 p-3" role="group" aria-label="The agent's question">
      <div className="flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0">
          <div className="text-[11.5px] font-medium uppercase tracking-wider text-accent">The agent asks</div>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[14px] font-medium">{question}</p>
        </div>
      </div>

      {options.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {options.map((o) => {
            const on = picked.includes(o)
            return (
              <button key={o} type="button" disabled={decide.isPending} aria-pressed={multiple ? on : undefined}
                onClick={() => (multiple ? setPicked(on ? picked.filter((p) => p !== o) : [...picked, o]) : answer(o))}
                className={cn('flex min-h-9 items-center gap-1.5 rounded-control border px-3.5 py-1.5 text-left text-[13px] transition-colors disabled:opacity-50 pointer-coarse:min-h-10',
                  on ? 'border-accent bg-accent text-accent-contrast' : 'border-border-strong bg-surface hover:border-accent hover:text-accent')}>
                {multiple && on && <Check className="h-3.5 w-3.5" />}
                {o}
              </button>
            )
          })}
          {multiple && (
            <Button size="sm" variant="primary" disabled={picked.length === 0} loading={decide.isPending}
              onClick={() => answer(picked.join(', '))}>
              Send {picked.length > 0 ? picked.length : ''}
            </Button>
          )}
        </div>
      )}

      <form onSubmit={sendOwn} className="mt-3 flex gap-2">
        <input value={own} onChange={(e) => setOwn(e.target.value)} aria-label="Your answer"
          placeholder={options.length ? 'Or write your own answer…' : 'Your answer…'}
          className="h-9 min-w-0 flex-1 rounded-control border border-border bg-surface px-3 text-[13.5px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft pointer-coarse:h-10" />
        <Button type="submit" size="icon" variant="secondary" aria-label="Send answer" disabled={!own.trim() || decide.isPending}>
          <Send className="h-4 w-4" />
        </Button>
      </form>
      {decide.isError && <p className="mt-2 text-[12px] text-error">{errorMessage(decide.error)}</p>}
    </div>
  )
}
