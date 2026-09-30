import { useState } from 'react'
import { AlertCircle, Brain, Check, ChevronRight, Copy, RotateCcw } from 'lucide-react'
import { Markdown } from '@/components/ui/Markdown'
import { cn } from '@/lib/cn'

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[14.5px]">
        {text}
      </div>
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
        {active ? 'Reasoning…' : 'Reasoning'}
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

interface AssistantProps {
  text: string
  reasoning?: string | null
  status: string // streaming | complete | cancelled | failed | queued | running
  error?: string | null
  modelLabel?: string | null
  notice?: string | null
  onRegenerate?: () => void
}

export function AssistantMessage({ text, reasoning, status, error, modelLabel, notice, onRegenerate }: AssistantProps) {
  const [copied, setCopied] = useState(false)
  const live = ['streaming', 'queued', 'running'].includes(status)
  const waiting = live && !text && !reasoning

  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="group">
      {notice && <div className="mb-2 text-[12px] text-warning">{notice}</div>}
      {reasoning && <ReasoningPanel text={reasoning} active={live && !text} />}
      {waiting && (
        <div className="flex items-center gap-1.5 py-2" aria-label="Waiting for the model">
          {[0, 150, 300].map((d) => (
            <span key={d} className="h-2 w-2 animate-bounce rounded-full bg-accent/60" style={{ animationDelay: `${d}ms` }} />
          ))}
        </div>
      )}
      {text && <Markdown text={text} />}
      {live && text && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-accent align-middle" />}

      {status === 'failed' && (
        <div className="mt-2 flex items-start gap-2 rounded-xl bg-error/10 px-3 py-2 text-[13px] text-error">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error ?? 'Something went wrong.'}</span>
        </div>
      )}

      {!live && (
        <div className="mt-2 flex items-center gap-1 text-[12px] text-subtle opacity-70 transition-opacity group-hover:opacity-100">
          {status === 'cancelled' && <span className="mr-2 rounded-full bg-surface-2 px-2 py-0.5 text-muted">Stopped</span>}
          {modelLabel && <span className="mr-2">{modelLabel}</span>}
          {text && (
            <button type="button" onClick={copy} className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-surface-hover hover:text-text">
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
          {onRegenerate && (
            <button type="button" onClick={onRegenerate} className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-surface-hover hover:text-text">
              <RotateCcw className="h-3.5 w-3.5" />
              {status === 'failed' ? 'Retry' : 'Regenerate'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
