import { Radio } from 'lucide-react'
import type { NotificationType } from '@/shared/preferences'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { Switch } from '../ui/Switch'
import { cn } from '../lib/cn'
import { usePreferences } from '../state/preferences'
import { useStored } from '../state/useStored'

const TYPES: { type: NotificationType; label: string; hint: string }[] = [
  { type: 'reminder', label: 'Reminders and due tasks', hint: 'Shown during focus too' },
  { type: 'calendar', label: 'Calendar events', hint: 'Event reminders; shown during focus too' },
  { type: 'approval', label: 'Approval requests and agent questions', hint: 'Opens the panel on the request; shown during focus too' },
  { type: 'agent', label: 'Finished agent runs and automations', hint: 'Runs over 2 minutes, or whose chat isn’t open' },
  { type: 'focus', label: 'Focus session ended', hint: '' },
]

const STATES: Record<string, { label: string; tone: string }> = {
  connected: { label: 'Live: connected', tone: 'bg-success' },
  connecting: { label: 'Connecting…', tone: 'bg-warning' },
  waiting: { label: 'Reconnecting soon', tone: 'bg-warning' },
  refused: { label: 'Anemo refused the connection (update Anemo, or EXTENSION_IDS)', tone: 'bg-error' },
  unauthorized: { label: 'Token revoked', tone: 'bg-error' },
  stopped: { label: 'Not connected', tone: 'bg-border-strong' },
}

/** Which notifications to show, and whether the live connection to Anemo is up. */
export function NotificationsCard() {
  const { prefs, update } = usePreferences()
  const stream = useStored('session', 'stream').value
  const state = STATES[stream?.state ?? 'stopped'] ?? STATES.stopped
  const on = prefs.features.notifications
  return (
    <Card>
      <CardHeader
        title="Notifications"
        description="During a focus session, everything except approvals and reminders waits and arrives as one summary when it ends."
      />
      <CardBody className="flex flex-col gap-1 py-2">
        <div className="mb-1 flex items-center gap-2 text-[12px] text-muted" title="The live connection that brings notifications, approvals and focus changes">
          <Radio className="h-3.5 w-3.5" />
          <span className={cn('h-2 w-2 rounded-full', state.tone)} />
          {state.label}
          {stream?.state === 'waiting' && stream.retryInMs ? ` (in ${Math.ceil(stream.retryInMs / 1000)} s)` : ''}
        </div>
        {TYPES.map((t) => (
          <div key={t.type} className="flex items-center gap-3 py-1.5">
            <div className={cn('min-w-0 flex-1', !on && 'opacity-50')}>
              <div className="text-[13px]">{t.label}</div>
              {t.hint && <div className="text-[11.5px] text-subtle">{t.hint}</div>}
            </div>
            <Switch
              label={t.label}
              disabled={!on}
              checked={on && prefs.notificationTypes[t.type]}
              onChange={(v) => void update((p) => ({ ...p, notificationTypes: { ...p.notificationTypes, [t.type]: v } }))}
            />
          </div>
        ))}
      </CardBody>
    </Card>
  )
}
