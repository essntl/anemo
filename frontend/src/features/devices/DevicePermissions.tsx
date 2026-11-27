import { useState } from 'react'
import { FolderPlus, Trash2 } from 'lucide-react'
import { ApiError, errorMessage } from '@/api/client'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { toast } from '@/components/ui/toast'
import { dateLocale, t } from '@/lib/i18n'
import { type DevicePermissions, type DeviceProfile, type WorkFolder, useDevicePermissions, useDeviceProfiles, useSetPermissions } from './api'
import { CATEGORIES, LEVEL_LABELS, PRESETS, PROTECTED_LABELS, PROTECTED_LEVEL_LABELS, profileName } from './permissionLabels'

function addedFrom(value: string): string {
  if (!value.startsWith('approval:')) return t('added in settings')
  const when = new Date(value.slice('approval:'.length))
  return Number.isNaN(when.getTime()) ? t('added from an approval') : t('added from an approval on {date}', { date: when.toLocaleDateString(dateLocale()) })
}

const quietReauth = (err: unknown) => {
  if (!(err instanceof ApiError && err.code === 'reauth_required')) toast({ message: errorMessage(err) })
}

/** Settings → Devices → a computer → Permissions (spec 25 §10): its profile, work folders,
 * protected folders, active grants and the automation switch. Every change applies at once. */
export function DevicePermissionsPanel({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  const permissions = useDevicePermissions(deviceId)
  const profiles = useDeviceProfiles()
  if (permissions.isError) return <p className="text-[13px] text-error">{errorMessage(permissions.error)}</p>
  if (!permissions.data || !profiles.data) return <p className="text-[12.5px] text-muted">{t('Loading…')}</p>
  return <PermissionsForm key={permissions.data.version} deviceId={deviceId} deviceName={deviceName} current={permissions.data} profiles={profiles.data} />
}

function PermissionsForm({ deviceId, deviceName, current, profiles }: {
  deviceId: string
  deviceName: string
  current: DevicePermissions
  profiles: DeviceProfile[]
}) {
  const save = useSetPermissions()
  const [folders, setFolders] = useState<WorkFolder[]>(current.work_folders)
  const [newPath, setNewPath] = useState('')
  const profile = current.profile
  const usesFolders = Object.values(profile.categories).includes('folders')
  const foldersDirty = JSON.stringify(folders) !== JSON.stringify(current.work_folders)

  const change = (body: Parameters<typeof save.mutate>[0]['change']) => save.mutate({ id: deviceId, change: body }, { onError: quietReauth })
  const addFolder = () => {
    const path = newPath.trim()
    if (!path) return
    setFolders([...folders, { path, recycle: true, added_from: 'settings' }])
    setNewPath('')
  }

  return (
    <div className="flex flex-col gap-4 rounded-control border border-border bg-surface-2 p-3" data-testid="device-permissions">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[13px] font-medium">{t('Profile')}</span>
        <Select aria-label={t('Profile of “{name}”', { name: deviceName })} value={profile.id} disabled={save.isPending}
          onValueChange={(id) => { if (id !== profile.id) change({ profile_id: id }) }}
          options={profiles.map((p) => ({ value: p.id, label: profileName(p) }))} />
      </div>
      {profile.preset && PRESETS[profile.preset] && <p className="-mt-2 text-[12px] text-muted">{t(PRESETS[profile.preset].description)}</p>}
      {current.waiting_for_confirmation && (
        <p role="status" className="rounded-control bg-warning/10 px-2 py-1.5 text-[12.5px] text-warning">
          {t('Waiting for confirmation on {name}: it keeps the old permissions until someone allows the change there.', { name: deviceName })}
        </p>
      )}
      {current.device_version != null && !current.analyser && usesFolders && (
        <p className="text-[12px] text-muted">{t('This computer’s Anemo Desktop doesn’t check commands itself yet; update it for work folders to apply to the shell.')}</p>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-5" aria-label={t('What the profile allows')}>
        {CATEGORIES.map((c) => (
          <div key={c.key} className="flex flex-col" title={t(c.hint)}>
            <span className="text-[12px] text-muted">{t(c.label)}</span>
            <span className="text-[12.5px] font-medium">{t(LEVEL_LABELS[profile.categories[c.key] ?? 'deny'])}</span>
          </div>
        ))}
      </div>

      <section className="flex flex-col gap-2">
        <div>
          <div className="text-[13px] font-medium">{t('Work folders')}</div>
          <div className="text-[12px] text-muted">
            {profile.preset === 'unrestricted'
              ? t('On Unrestricted the whole computer is a work folder; these apply to automations unless “Unrestricted for automations” is on.')
              : usesFolders
                ? t('An agent may read, change, delete and run programs here without asking. Everywhere else is read-only.')
                : t('This profile doesn’t use work folders yet; they are kept for when it does.')}
          </div>
        </div>
        {folders.map((f, i) => (
          <div key={f.path} className="flex flex-wrap items-center gap-2 text-[12.5px]" data-testid="work-folder">
            <code className="min-w-0 flex-1 truncate font-mono">{f.path}</code>
            <label className="flex items-center gap-1.5 text-muted">
              <Checkbox checked={f.recycle} onChange={(e) => setFolders(folders.map((x, j) => (j === i ? { ...x, recycle: e.target.checked } : x)))} />
              {t('Recycle Bin')}
            </label>
            <span className="text-[11.5px] text-subtle">{addedFrom(f.added_from)}</span>
            <Button size="sm" variant="ghost" className="px-2" aria-label={t('Remove {path}', { path: f.path })} icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => setFolders(folders.filter((_, j) => j !== i))} />
          </div>
        ))}
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); addFolder() }}>
          <Input className="min-w-0 flex-1 font-mono text-[12.5px]" value={newPath} maxLength={400} aria-label={t('New work folder')}
            placeholder={t('e.g. C:\\Users\\you\\Documents\\notes')} onChange={(e) => setNewPath(e.target.value)} />
          <Button size="sm" type="submit" variant="ghost" icon={<FolderPlus className="h-3.5 w-3.5" />} disabled={!newPath.trim()}>{t('Add')}</Button>
          <Button size="sm" variant="primary" disabled={!foldersDirty} loading={save.isPending} onClick={() => change({ work_folders: folders })}>{t('Save folders')}</Button>
        </form>
      </section>

      <section className="flex flex-col gap-1.5">
        <div className="text-[13px] font-medium">{t('Protected folders')}</div>
        <div className="text-[12px] text-muted">{t('Checked before the work folders; a work folder can’t open them up.')}</div>
        {current.protected.map((p) => (
          <div key={p.key} className="flex flex-wrap items-center gap-2 text-[12.5px]" title={p.paths.join('\n')}>
            <span className="min-w-0 flex-1">{PROTECTED_LABELS[p.key] ? t(PROTECTED_LABELS[p.key]) : p.label}</span>
            {p.adjustable ? (
              <Select variant="pill" aria-label={t('Level for {folder}', { folder: PROTECTED_LABELS[p.key] ? t(PROTECTED_LABELS[p.key]) : p.label })} value={p.level}
                disabled={save.isPending}
                onValueChange={(level) => change({ protected_overrides: { ...Object.fromEntries(current.protected.filter((x) => x.adjustable && x.level === 'ask').map((x) => [x.key, 'ask'])), [p.key]: level as 'deny' | 'ask' } })}
                options={[{ value: 'deny', label: t(PROTECTED_LEVEL_LABELS.deny) }, { value: 'ask', label: t(PROTECTED_LEVEL_LABELS.ask) }]} />
            ) : (
              <Badge tone={p.level === 'hard' ? 'warning' : undefined}>{t(PROTECTED_LEVEL_LABELS[p.level] ?? p.level)}</Badge>
            )}
          </div>
        ))}
      </section>

      {(current.grants ?? []).length > 0 && (
        <section className="flex flex-col gap-1.5">
          <div className="text-[13px] font-medium">{t('Approved for the next hour')}</div>
          {(current.grants ?? []).map((g) => (
            <div key={g.id} className="flex items-center gap-2 text-[12.5px]">
              <code className="min-w-0 flex-1 truncate font-mono">{g.folder ?? t('one exact command')}</code>
              <span className="text-muted">{t('until {time}', { time: new Date(g.expires_at).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }) })}</span>
            </div>
          ))}
        </section>
      )}

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[13px] font-medium">{t('Unrestricted for automations')}</div>
          <div className="text-[12px] text-muted">{t('Off: an automation on an Unrestricted computer works as Scoped, with the same work folders.')}</div>
        </div>
        <Switch label={t('Unrestricted for automations')} checked={current.automations_unrestricted} disabled={save.isPending}
          onChange={(v) => change({ automations_unrestricted: v })} />
      </div>
    </div>
  )
}
