import { useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { usePauseRun, useResumeRun } from '@/features/runs/api'

interface RunControlsProps {
  runId: string
  status: string
  pauseRequested: boolean
  /** Show a text box to send the agent a message when resuming. */
  withMessage?: boolean
}

/**
 * Pause and resume an agent run. A pause takes effect at the next safe point:
 * the current model answer or tool call finishes, nothing new starts.
 * (Cancelling is the Stop button in the chat, or on the run's page.)
 */
export function RunControls({ runId, status, pauseRequested, withMessage }: RunControlsProps) {
  const pause = usePauseRun()
  const resume = useResumeRun()
  const [message, setMessage] = useState('')
  const error = pause.error ?? resume.error

  let controls = null
  if (status === 'paused') {
    const go = () => resume.mutate({ runId, message: message.trim() || undefined }, { onSuccess: () => setMessage('') })
    controls = (
      <div className="flex flex-wrap items-center gap-2">
        {withMessage && (
          <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Optional: a message for the agent"
            className="h-8 min-w-48 flex-1 text-[13px]" onKeyDown={(e) => e.key === 'Enter' && go()} />
        )}
        <Button size="sm" variant="primary" icon={<Play className="h-3.5 w-3.5" />} loading={resume.isPending} onClick={go}>
          Resume
        </Button>
      </div>
    )
  } else if (pauseRequested && status === 'running') {
    controls = (
      <div className="flex items-center gap-2 text-[12px] text-muted">
        Pausing after the current step…
        <Button size="sm" variant="ghost" loading={resume.isPending} onClick={() => resume.mutate({ runId })}>
          Keep going
        </Button>
      </div>
    )
  } else if (status === 'running' || status === 'queued') {
    controls = (
      <Button size="sm" variant="ghost" icon={<Pause className="h-3.5 w-3.5" />} loading={pause.isPending}
        onClick={() => pause.mutate(runId)} title="Pause after the current step">
        Pause
      </Button>
    )
  }
  if (!controls) return null
  return (
    <div className="flex flex-col gap-1">
      {controls}
      {error && <span className="text-[12px] text-error">{errorMessage(error)}</span>}
    </div>
  )
}
