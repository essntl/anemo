/** On the logo: whether the live connection to Anemo is up (notifications, timer, approvals). */
import { useStored } from '../state/useStored'
import { cn } from '../lib/cn'

const STATES: Record<string, { color: string; text: string }> = {
  connected: { color: 'bg-success', text: 'Connected to Anemo' },
  connecting: { color: 'bg-warning', text: 'Connecting to Anemo…' },
  waiting: { color: 'bg-warning', text: 'Anemo can’t be reached right now. Trying again by itself.' },
  refused: { color: 'bg-error', text: 'Anemo refuses this extension’s live connection (see Settings).' },
  unauthorized: { color: 'bg-error', text: 'The token no longer works.' },
  stopped: { color: 'bg-border-strong', text: 'Not connected' },
}

export function StatusDot() {
  const stream = useStored('session', 'stream').value
  const s = STATES[stream?.state ?? 'connecting'] ?? STATES.connecting
  return (
    <span className="relative mr-1 shrink-0" title={s.text} role="img" aria-label={s.text}>
      <img src="/icons/icon-32.png" alt="" className="h-6 w-6 rounded-md" />
      <span className={cn('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface', s.color)} data-testid="status-dot" data-state={stream?.state ?? 'connecting'} />
    </span>
  )
}
