import { useId, useState } from 'react'
import { Check, Copy, Monitor, Plus, Smartphone } from 'lucide-react'
import { ApiError, errorMessage } from '@/api/client'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { confirmDialog, promptDialog } from '@/components/ui/dialogs'
import { Input } from '@/components/ui/Input'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { toast } from '@/components/ui/toast'
import { formatWhen } from '@/lib/format'
import { msg, t } from '@/lib/i18n'
import { DeviceCodeCard } from './DeviceCodeCard'
import { DeviceFilesCard } from './DeviceFilesCard'
import { DevicePermissionsPanel } from './DevicePermissions'
import { DeviceProfilesCard } from './DeviceProfilesCard'
import { PRESETS, profileName } from './permissionLabels'
import { type Device, type DeviceKind, useAddDevice, useDeleteDevice, useDeviceProfiles, useDevices, useRenameDevice, useSetPermissions } from './api'

const KINDS = [
  { value: 'computer' as const, label: msg('Computer') },
  { value: 'phone' as const, label: msg('Phone') },
]


/** The token just made: shown once, here, until Done. */
function NewDevice({ name, kind, token, onDone }: { name: string; kind: DeviceKind; token: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
    } catch {
      toast({ message: t('The token could not be copied. Select it and copy it yourself.') })
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-control border border-border bg-surface-2 p-3" role="status">
      <div className="text-[13px] font-medium">{t('“{name}” is added. Copy its token now: it is shown only this once.', { name })}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md bg-surface px-2 py-1.5 font-mono text-[12px]" data-testid="new-device-token">
          {token}
        </code>
        <Button size="sm" icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} onClick={copy}>
          {copied ? t('Copied') : t('Copy')}
        </Button>
      </div>
      <p className="text-[12px] text-muted">
        {kind === 'computer'
          ? t('Paste it into Anemo Desktop on that computer, with this address: {address}', { address: window.location.origin })
          : t('Paste it into Anemo Voice on that phone, with this address: {address}', { address: window.location.origin })}
      </p>
      <p className="text-[12px] text-muted">
        {t('Anyone with this token can use your workspace, except changes that need your password, until you delete the device here.')}
      </p>
      <div>
        <Button size="sm" variant="ghost" onClick={onDone}>{t('Done')}</Button>
      </div>
    </div>
  )
}

function AddDevice({ onAdded }: { onAdded: (made: { name: string; kind: DeviceKind; token: string }) => void }) {
  const add = useAddDevice()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<DeviceKind>('computer')
  const profiles = useDeviceProfiles()
  const watched = profiles.data?.find((p) => p.preset === 'watched')
  const [chosen, setChosen] = useState<string | null>(null)
  const profileId = chosen ?? watched?.id ?? null
  const profile = profiles.data?.find((p) => p.id === profileId)
  const nameId = useId()

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    add.mutate(
      { name: name.trim(), kind, trust: 'watched', ...(kind === 'computer' && profileId ? { profile_id: profileId } : {}) },
      {
        onSuccess: (made) => {
          onAdded({ name: made.name, kind: made.kind, token: made.token })
          setName('')
        },
      },
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-col">
        <label htmlFor={nameId} className="mb-1.5 block text-[13px] font-medium">{t('Name')}</label>
        <Input id={nameId} aria-describedby={`${nameId}-hint`} className="sm:max-w-md" value={name} maxLength={100}
          onChange={(e) => setName(e.target.value)} placeholder={t('e.g. VM, Desk PC, Laptop')} />
        <span id={`${nameId}-hint`} className="mt-1 block text-[12px] text-muted">
          {t('The agent names the device by it, so keep it short.')}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">{t('Kind')}</span>
        <Segmented<DeviceKind> label={t('Kind')} className="self-start" value={kind} onChange={setKind}
          options={KINDS.map((k) => ({ value: k.value, label: t(k.label) }))} />
      </div>
      {kind === 'computer' && profiles.data && profileId && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">{t('Permission profile')}</span>
          <Select className="sm:max-w-xs" aria-label={t('Permission profile')} value={profileId} onValueChange={setChosen}
            options={profiles.data.map((p) => ({ value: p.id, label: profileName(p) }))} />
          {profile?.preset && PRESETS[profile.preset] && <span className="text-[12px] text-muted">{t(PRESETS[profile.preset].description)}</span>}
        </div>
      )}
      <div>
        <Button type="submit" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} disabled={!name.trim()} loading={add.isPending}>
          {t('Add device')}
        </Button>
      </div>
      {add.isError && !(add.error instanceof ApiError && add.error.code === 'reauth_required') && (
        <p className="text-[13px] text-error">{errorMessage(add.error)}</p>
      )}
    </form>
  )
}

function DeviceRow({ device }: { device: Device }) {
  const rename = useRenameDevice()
  const setPermissions = useSetPermissions()
  const profiles = useDeviceProfiles()
  const [open, setOpen] = useState(false)
  const remove = useDeleteDevice()
  const Icon = device.kind === 'phone' ? Smartphone : Monitor

  const askRename = async () => {
    const name = await promptDialog({ title: t('Rename “{name}”', { name: device.name }), label: t('Name'), initial: device.name, confirmLabel: t('Rename') })
    if (!name?.trim() || name.trim() === device.name) return
    rename.mutate({ id: device.id, name: name.trim() }, { onError: (err) => toast({ message: errorMessage(err) }) })
  }

  const changeProfile = (profileId: string) => {
    if (profileId === device.profile_id) return
    setPermissions.mutate(
      { id: device.id, change: { profile_id: profileId } },
      { onError: (err) => { if (!(err instanceof ApiError && err.code === 'reauth_required')) toast({ message: errorMessage(err) }) } },
    )
  }

  const askDelete = async () => {
    const ok = await confirmDialog({
      title: t('Delete “{name}”?', { name: device.name }),
      message: t('Its token stops working and its connection closes at once. To use it again, add it again and paste the new token.'),
      confirmLabel: t('Delete'),
      danger: true,
    })
    if (ok) remove.mutate(device.id, { onError: (err) => toast({ message: errorMessage(err) }) })
  }

  const seen = device.last_seen_at ? t('last seen {when}', { when: formatWhen(device.last_seen_at) }) : t('never connected')
  return (
    <div className="flex flex-wrap items-center gap-3 py-3" data-testid="device-row">
      <Icon className="h-4 w-4 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{device.name}</span>
          {device.online ? <Badge tone="success">{t('Online')}</Badge> : <Badge>{t('Offline')}</Badge>}
          {device.online && device.kind === 'computer' && !device.control && <Badge tone="warning">{t('Control off')}</Badge>}
        </div>
        <div className="text-[12px] text-muted">
          {device.kind === 'phone' ? t('Phone') : t('Computer')} · {device.online ? t('connected now') : seen}
          {device.client_version ? ` · ${t('version {version}', { version: device.client_version })}` : ''}
        </div>
      </div>
      {device.kind === 'computer' && (
        <Select variant="pill" aria-label={t('Profile of “{name}”', { name: device.name })} value={device.profile_id}
          onValueChange={changeProfile} disabled={setPermissions.isPending || !profiles.data}
          options={(profiles.data ?? [{ id: device.profile_id, name: device.profile_name, preset: null }]).map((p) => ({ value: p.id, label: profileName(p) }))} />
      )}
      {device.kind === 'computer' && (
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{t('Permissions')}</Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => void askRename()}>{t('Rename')}</Button>
      <Button size="sm" variant="ghost" onClick={() => void askDelete()}>{t('Delete')}</Button>
      {open && <div className="basis-full"><DevicePermissionsPanel deviceId={device.id} deviceName={device.name} /></div>}
    </div>
  )
}

/** Settings → Devices: the computers (Anemo Desktop) and phones (Anemo Voice) Anemo can reach. */
export function DevicesSettingsPage() {
  const devices = useDevices()
  const [made, setMade] = useState<{ name: string; kind: DeviceKind; token: string } | null>(null)

  return (
    <div className="flex flex-col gap-(--card-gap)">
      <Card>
        <CardHeader title={t('Devices')}
          description={t('Your computers (Anemo Desktop) and phones (Anemo Voice). Each has its own token and, for computers, a permission profile and work folders. Changing them asks for your password.')} />
        <CardBody className="flex flex-col gap-4">
          {made ? <NewDevice {...made} onDone={() => setMade(null)} /> : <AddDevice onAdded={setMade} />}
        </CardBody>
      </Card>
      {(devices.data?.length ?? 0) > 0 && (
        <Card>
          <CardBody className="flex flex-col divide-y divide-border py-1">
            {devices.data?.map((device) => <DeviceRow key={device.id} device={device} />)}
          </CardBody>
        </Card>
      )}
      {devices.isError && <p className="text-[13px] text-error">{errorMessage(devices.error)}</p>}
      <DeviceProfilesCard />
      <DeviceFilesCard />
      <DeviceCodeCard />
    </div>
  )
}
