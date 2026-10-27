import { CheckCircle2, CircleAlert, Copy, Power } from 'lucide-react'
import { useClaudeCodeStatus } from '../api'

function Command({ text }: { text: string }) {
  return (
    <span className="mt-1 flex items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded-control bg-surface-2 px-2 py-1 font-mono text-[12px]">
        {text}
      </code>
      <button
        type="button"
        aria-label="Copy command"
        title="Copy"
        className="rounded-control p-1 text-muted hover:bg-surface-hover"
        onClick={() => void navigator.clipboard?.writeText(text)}
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </span>
  )
}

/** Whether the claude-runner is running and signed in with a Claude subscription,
 *  and the command to fix it when it is not. There is no key to enter: Claude Code
 *  signs in inside its own container. */
export function ClaudeCodeStatus() {
  const status = useClaudeCodeStatus()
  const s = status.data
  if (!s) return <p className="text-[13px] text-muted">Checking the claude-runner…</p>
  if (s.state === 'signed_in') {
    return (
      <p className="flex items-center gap-1.5 text-[13px] text-success">
        <CheckCircle2 className="h-4 w-4" /> Signed in with a Claude subscription
        {s.cli_version ? <span className="text-muted">· Claude Code {s.cli_version}</span> : null}
      </p>
    )
  }
  if (s.state === 'not_signed_in') {
    return (
      <div className="text-[13px]">
        <p className="flex items-center gap-1.5 text-warning">
          <CircleAlert className="h-4 w-4" /> Not signed in with a Claude subscription
          {s.auth_method ? <span className="text-muted">(signed in as: {s.auth_method})</span> : null}
        </p>
        <p className="mt-1 text-muted">Sign in once, from a terminal on the server:</p>
        <Command text={s.login_command} />
      </div>
    )
  }
  return (
    <div className="text-[13px]">
      <p className="flex items-center gap-1.5 text-error">
        <Power className="h-4 w-4" /> The claude-runner is not running
      </p>
      <p className="mt-1 text-muted">Start it, then sign in once:</p>
      <Command text={s.start_command} />
      <Command text={s.login_command} />
    </div>
  )
}
