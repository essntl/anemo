/**
 * A shell command in the agent's activity, shown like a terminal: the command,
 * where it ran, and its output (live while it runs, from the timeline afterwards).
 */
import { useEffect, useRef } from 'react'
import { Globe } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { ToolCallView } from '../api'
import { useShellOutput } from '../shellOutput'

interface ShellResult {
  command: string
  cwd: string
  network: boolean
  exit_code: number | null
  timed_out: boolean
  truncated: boolean
  duration_ms: number
  stdout: string
  stderr: string
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

export function ShellDetails({ call }: { call: ToolCallView }) {
  const shell = call.result_data?.shell as ShellResult | undefined
  const live = useShellOutput((s) => s.output[call.id])
  const running = call.status === 'running'
  const args = call.args as { command?: string; cwd?: string; network?: boolean }
  const command = shell?.command ?? args.command ?? ''
  const network = shell?.network ?? args.network

  // Keep the newest output in view while it streams in.
  const outputRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (running && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [live, running])

  const output = shell ? null : live
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-[11.5px] text-muted">
        <span className="font-mono">{shell?.cwd ?? args.cwd ?? '.'}</span>
        {network && (
          <span className="flex items-center gap-1 text-warning">
            <Globe className="h-3 w-3" /> internet
          </span>
        )}
        {shell && (
          <>
            <span className={cn('font-medium', shell.exit_code === 0 ? 'text-tool-ok' : 'text-error')}>
              {shell.exit_code === null ? 'no exit code' : `exit ${shell.exit_code}`}
            </span>
            <span>{formatDuration(shell.duration_ms)}</span>
            {shell.timed_out && <span className="text-error">timed out</span>}
            {shell.truncated && <span>output shortened</span>}
          </>
        )}
        {running && <span className="text-tool-running">running…</span>}
      </div>
      <pre ref={outputRef}
        className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11.5px] leading-relaxed">
        <span className="text-accent">$ </span>
        <span className="font-semibold">{command}</span>
        {'\n'}
        {shell ? (
          <>
            {shell.stdout}
            {shell.stderr && <span className="text-error">{shell.stderr}</span>}
            {!shell.stdout && !shell.stderr && <span className="text-subtle">(no output)</span>}
          </>
        ) : (
          output ?? (running ? '' : <span className="text-subtle">{call.result ?? ''}</span>)
        )}
      </pre>
    </div>
  )
}
