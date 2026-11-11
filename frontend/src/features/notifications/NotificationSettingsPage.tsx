/**
 * Settings > Notifications: desktop notifications on this device, push
 * notifications (this device and the others that have it on), and the Discord
 * channels that get a copy. Notifications always appear in the app.
 */
import { useEffect, useState } from 'react'
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
import { msg, rich, t } from '@/lib/i18n'
import {
  type Destination,
  KIND_LABELS,
  type NotificationKind,
  useDeleteDestination,
  useDestinations,
  useDisablePush,
  useEnablePush,
  useSaveDestination,
  useTestDestination,
} from './api'
import { DestinationDialog } from './components/DestinationDialog'
import { desktopEnabled, desktopSupport, setDesktopEnabled } from './desktop'
import { currentSubscription, endpointHash, PushPermissionError, type PushSupport, pushOnHere, pushSupport } from './push'
import { Lingering } from '@/components/ui/Lingering'

const UNAVAILABLE = {
  unsupported: msg('This browser does not support desktop notifications. On an iPhone or iPad, use push notifications instead.'),
  insecure: msg('Browsers only allow desktop notifications over HTTPS. Open the app through its https:// address.'),
  blocked: msg('Notifications are blocked for this site. Allow them in the browser’s site settings (the icon next to the address), then reload.'),
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
      <CardHeader title={t('On this device')} />
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4 text-[13px]">
          <div>
            <div className="font-medium">{t('Desktop notifications')}</div>
            <div className="text-[12px] text-muted">
              {t('Shown by your browser while Anemo is open in a tab you are not looking at. Set per browser. With the app closed nothing can be shown; push notifications reach you then.')}
              {pushOnHere() && ' ' + t('Push is on in this browser, so it shows them instead.')}
            </div>
          </div>
          <Switch label={t('Desktop notifications')} checked={on} disabled={support !== 'ok'} onChange={(next) => void change(next)} />
        </div>
        {support !== 'ok' && <p className="text-[12.5px] text-warning">{t(UNAVAILABLE[support])}</p>}
        {refused && support === 'ok' && <p className="text-[12.5px] text-warning">{t('The browser did not give permission.')}</p>}
      </CardBody>
    </Card>
  )
}

function DestinationRow({ destination, onEdit, thisDevice = false, onRemoveThisDevice }: {
  destination: Destination
  onEdit: () => void
  /** Push: the device this page is open on. */
  thisDevice?: boolean
  /** Removing this device also turns push off in this browser. */
  onRemoveThisDevice?: () => void
}) {
  const save = useSaveDestination()
  const remove = useDeleteDestination()
  const test = useTestDestination()
  const push = destination.type === 'webpush'
  const form = { name: destination.name, url: '', kinds: destination.kinds as NotificationKind[] }

  const confirmDelete = async () => {
    const ok = await confirmDialog({
      title: t('Remove “{name}”?', { name: destination.name }),
      message: push
        ? t('This device no longer gets push notifications. To get them again, turn push on there.')
        : t('Notifications are no longer sent there. The saved webhook URL is deleted.'),
      confirmLabel: t('Remove'),
      danger: true,
    })
    if (!ok) return
    if (thisDevice && onRemoveThisDevice) onRemoveThisDevice()
    else remove.mutate(destination.id)
  }
  const error = save.error ?? remove.error ?? test.error

  return (
    <div className="rounded-control border border-border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[14px] font-medium">
            <span className="truncate">{destination.name}</span>
            <Badge>{push ? t('Push') : 'Discord'}</Badge>
            {thisDevice && <Badge tone="accent">{t('This device')}</Badge>}
            {!destination.enabled && <Badge tone="warning">{t('Off')}</Badge>}
          </div>
          <div className="mt-0.5 text-[12px] text-muted">
            {destination.kinds.length === 0 ? t('Only automations that pick it') : t('{n} of {total} kinds', { n: destination.kinds.length, total: Object.keys(KIND_LABELS).length })}
            {destination.last_sent_at && <> · {t('last sent {when}', { when: formatWhen(destination.last_sent_at) })}</>}
          </div>
        </div>
        <Button size="sm" variant="secondary" icon={<Send className="h-3.5 w-3.5" />} loading={test.isPending}
          onClick={() => test.mutate(destination.id)}>
          {t('Test')}
        </Button>
        <Switch label={t('Send to {name}', { name: destination.name })} checked={destination.enabled}
          onChange={(enabled) => save.mutate({ id: destination.id, form: { ...form, enabled } })} />
        <ActionMenu actions={[
          { label: t('Edit'), icon: <Pencil />, onSelect: onEdit },
          { label: t('Remove'), icon: <Trash2 />, danger: true, onSelect: () => void confirmDelete() },
        ]} />
      </div>
      {test.data && (
        <p className={`mt-2 flex items-center gap-1.5 text-[12.5px] ${test.data.ok ? 'text-success' : 'text-error'}`}>
          {test.data.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
          {test.data.message}
        </p>
      )}
      {!test.data && destination.last_error && (
        <p className="mt-2 text-[12.5px] text-error">{t('Last attempt failed: {error}', { error: destination.last_error })}</p>
      )}
      {error && <p className="mt-2 text-[12.5px] text-error">{errorMessage(error)}</p>}
    </div>
  )
}

const PUSH_UNAVAILABLE: Record<Exclude<PushSupport, 'ok'>, string> = {
  unsupported: msg('This browser does not support push notifications.'),
  insecure: msg('Push notifications need HTTPS. Open the app through its https:// address.'),
  blocked: msg('Notifications are blocked for this site. Allow them in the browser’s site settings (the icon next to the address), then reload.'),
  'ios-install': msg('On an iPhone or iPad, push notifications work once Anemo is on your Home Screen: Share › Add to Home Screen, then open it from there and come back here.'),
  dev: msg('Push notifications need the built app (its service worker is not used by the development server).'),
}

/** The SHA-256 of this browser's subscription address, once known (null: none). */
function useThisDeviceHash(devices: Destination[]): string | null | undefined {
  const [hash, setHash] = useState<string | null | undefined>(undefined)
  // Look again whenever the list changes (after turning push on or off).
  const key = devices.map((d) => d.endpoint_hash).join()
  useEffect(() => {
    let cancelled = false
    void currentSubscription().then(async (sub) => {
      const value = sub ? await endpointHash(sub.endpoint) : null
      if (!cancelled) setHash(value)
    })
    return () => {
      cancelled = true
    }
  }, [key])
  return hash
}

export function PushCard({ devices, onEdit }: { devices: Destination[]; onEdit: (d: Destination) => void }) {
  const support = pushSupport()
  const enable = useEnablePush()
  const disable = useDisablePush()
  const hash = useThisDeviceHash(devices)
  const on = !!hash && devices.some((d) => d.endpoint_hash === hash)
  const busy = enable.isPending || disable.isPending || hash === undefined
  const error = enable.error ?? disable.error

  const change = (next: boolean) => {
    if (next) enable.mutate()
    else disable.mutate(devices)
  }

  return (
    <Card>
      <CardHeader title={t('Push notifications')}
        description={t('Notifications on your phone or computer even while Anemo is closed. Turn it on in each browser or phone you want them on; changes ask for your password.')} />
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4 text-[13px]">
          <div>
            <div className="font-medium">{t('On this device')}</div>
            <div className="text-[12px] text-muted">
              {rich('When an automation needs your approval, the notification has <em>Allow once</em> and <em>Deny</em> buttons. On an iPhone or iPad there are no buttons: tap the notification to answer in the app.', { em: (c) => <em>{c}</em> })}
            </div>
          </div>
          <Switch label={t('Push notifications on this device')} checked={on} disabled={support !== 'ok' || busy}
            onChange={change} />
        </div>
        {support !== 'ok' && <p className="text-[12.5px] text-warning">{t(PUSH_UNAVAILABLE[support])}</p>}
        {error && (
          <p className="text-[12.5px] text-error">
            {error instanceof PushPermissionError ? error.message : errorMessage(error)}
          </p>
        )}
        {devices.length > 0 && (
          <div className="flex flex-col gap-2">
            {devices.map((d) => (
              <DestinationRow key={d.id} destination={d} onEdit={() => onEdit(d)}
                thisDevice={!!hash && d.endpoint_hash === hash} onRemoveThisDevice={() => disable.mutate(devices)} />
            ))}
          </div>
        )}
        {devices.length === 0 && support === 'ok' && (
          <p className="text-[12.5px] text-muted">{t('No device has push on yet.')}</p>
        )}
      </CardBody>
    </Card>
  )
}

export function NotificationSettingsPage() {
  const destinations = useDestinations()
  // null: closed. { destination: null }: adding one.
  const [editing, setEditing] = useState<{ destination: Destination | null } | null>(null)
  const all = destinations.data ?? []
  const items = all.filter((d) => d.type !== 'webpush')
  const devices = all.filter((d) => d.type === 'webpush')

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Bell className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">{t('Notifications')}</h2>
          <p className="text-[13px] text-muted">
            {rich('Reminders, automation results and agent messages are always listed under <a>Notifications</a>. Here you choose where else they go.', { a: (c) => <Link to="/notifications" className="text-accent underline">{c}</Link> })}
          </p>
        </div>
      </div>

      <PushCard devices={devices} onEdit={(d) => setEditing({ destination: d })} />

      <DesktopCard />

      <Card>
        <CardHeader title="Discord"
          description={t('Get notifications in a Discord channel as well. Changes ask for your password.')}
          actions={
            <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ destination: null })}>
              {t('Add')}
            </Button>
          } />
        <CardBody className="flex flex-col gap-2">
          {destinations.isError && <p className="text-[13px] text-error">{errorMessage(destinations.error)}</p>}
          {destinations.isSuccess && items.length === 0 && (
            <p className="text-[13px] text-muted">{t('No channel yet. Add one with a webhook URL from Discord.')}</p>
          )}
          {items.map((d) => <DestinationRow key={d.id} destination={d} onEdit={() => setEditing({ destination: d })} />)}
        </CardBody>
      </Card>

      <Lingering value={editing}>{(shown) => <DestinationDialog destination={shown.destination} onClose={() => setEditing(null)} />}</Lingering>
    </div>
  )
}
