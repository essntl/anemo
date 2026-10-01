/**
 * Settings > Notifications: desktop notifications on this device, and the
 * Discord channels that get a copy. Notifications always appear in the app.
 */
import { useState } from 'react'
import { Link } from 'react-router'
import { Bell, CheckCircle2, Pencil, Plus, Send, Trash2, XCircle } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { confirmDialog } from '@/components/ui/dialogs'
import { Switch } from '@/components/ui/Switch'
import { formatWhen } from '@/lib/format'
import { type Destination, type NotificationKind, useDeleteDestination, useDestinations, useSaveDestination, useTestDestination } from './api'
import { DestinationDialog } from './components/DestinationDialog'
import { desktopEnabled, desktopSupport, setDesktopEnabled } from './desktop'

const UNAVAILABLE = {
  unsupported: 'This browser does not support desktop notifications. On an iPhone or iPad, use a Discord channel instead.',
  insecure: 'Browsers only allow desktop notifications over HTTPS. Open the app through its https:// address.',
  blocked: 'Notifications are blocked for this site. Allow them in the browser’s site settings (the icon next to the address), then reload.',
}

function DesktopCard() {
  const support = desktopSupport()
  const [on, setOn] = useState(desktopEnabled)
  const [refused, setRefused] = useState(false)

  const change = async (next: boolean) => {
    const result = await setDesktopEnabled(next)
    setOn(result)
    setRefused(next && !result)
  }

  return (
    <Card>
      <CardHeader title="On this device" />
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4 text-[13px]">
          <div>
            <div className="font-medium">Desktop notifications</div>
            <div className="text-[12px] text-muted">
              Shown by your browser while Anemo is open in a tab you are not looking at. Set per browser.
              With the app closed nothing can be shown; a Discord channel reaches you then.
            </div>
          </div>
          <Switch label="Desktop notifications" checked={on} disabled={support !== 'ok'} onChange={(next) => void change(next)} />
        </div>
        {support !== 'ok' && <p className="text-[12.5px] text-warning">{UNAVAILABLE[support]}</p>}
        {refused && support === 'ok' && <p className="text-[12.5px] text-warning">The browser did not give permission.</p>}
      </CardBody>
    </Card>
  )
}

function DestinationRow({ destination, onEdit }: { destination: Destination; onEdit: () => void }) {
  const save = useSaveDestination()
  const remove = useDeleteDestination()
  const test = useTestDestination()
  const form = { name: destination.name, url: '', kinds: destination.kinds as NotificationKind[] }

  const confirmDelete = async () => {
    const ok = await confirmDialog({
      title: `Remove “${destination.name}”?`,
      message: 'Notifications are no longer sent there. The saved webhook URL is deleted.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (ok) remove.mutate(destination.id)
  }
  const error = save.error ?? remove.error ?? test.error

  return (
    <div className="rounded-control border border-border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[14px] font-medium">
            <span className="truncate">{destination.name}</span>
            <Badge>Discord</Badge>
            {!destination.enabled && <Badge tone="warning">Off</Badge>}
          </div>
          <div className="mt-0.5 text-[12px] text-muted">
            {destination.kinds.length === 0 ? 'Only automations that pick it' : `${destination.kinds.length} of 4 kinds`}
            {destination.last_sent_at && <> · last sent {formatWhen(destination.last_sent_at)}</>}
          </div>
        </div>
        <Button size="sm" variant="secondary" icon={<Send className="h-3.5 w-3.5" />} loading={test.isPending}
          onClick={() => test.mutate(destination.id)}>
          Test
        </Button>
        <Switch label={`Send to ${destination.name}`} checked={destination.enabled}
          onChange={(enabled) => save.mutate({ id: destination.id, form: { ...form, enabled } })} />
        <ActionMenu actions={[
          { label: 'Edit', icon: <Pencil />, onSelect: onEdit },
          { label: 'Remove', icon: <Trash2 />, danger: true, onSelect: () => void confirmDelete() },
        ]} />
      </div>
      {test.data && (
        <p className={`mt-2 flex items-center gap-1.5 text-[12.5px] ${test.data.ok ? 'text-success' : 'text-error'}`}>
          {test.data.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
          {test.data.message}
        </p>
      )}
      {!test.data && destination.last_error && (
        <p className="mt-2 text-[12.5px] text-error">Last attempt failed: {destination.last_error}</p>
      )}
      {error && <p className="mt-2 text-[12.5px] text-error">{errorMessage(error)}</p>}
    </div>
  )
}

export function NotificationSettingsPage() {
  const destinations = useDestinations()
  // null: closed. { destination: null }: adding one.
  const [editing, setEditing] = useState<{ destination: Destination | null } | null>(null)
  const items = destinations.data ?? []

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Bell className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Notifications</h2>
          <p className="text-[13px] text-muted">
            Reminders, automation results and agent messages are always listed under{' '}
            <Link to="/notifications" className="text-accent underline">Notifications</Link>. Here you choose where else they go.
          </p>
        </div>
      </div>

      <DesktopCard />

      <Card>
        <CardHeader title="Discord"
          description="Get notifications in a Discord channel, so they reach your phone when the app is closed. Changes ask for your password."
          actions={
            <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ destination: null })}>
              Add
            </Button>
          } />
        <CardBody className="flex flex-col gap-2">
          {destinations.isError && <p className="text-[13px] text-error">{errorMessage(destinations.error)}</p>}
          {destinations.isSuccess && items.length === 0 && (
            <p className="text-[13px] text-muted">No channel yet. Add one with a webhook URL from Discord.</p>
          )}
          {items.map((d) => <DestinationRow key={d.id} destination={d} onEdit={() => setEditing({ destination: d })} />)}
        </CardBody>
      </Card>

      {editing && <DestinationDialog destination={editing.destination} onClose={() => setEditing(null)} />}
    </div>
  )
}
