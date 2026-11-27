import { ApiError, errorMessage } from '@/api/client'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { confirmDialog, promptDialog } from '@/components/ui/dialogs'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { toast } from '@/components/ui/toast'
import { plural, t } from '@/lib/i18n'
import { useModels } from '@/features/providers/api'
import { useSaveSection, useSettings } from '@/features/settings/api'
import { type CategoryLevel, type DeviceProfile, useChangeProfile, useCopyProfile, useDeleteProfile, useDeviceProfiles } from './api'
import { CATEGORIES, LEVEL_LABELS, levelsFor, profileName } from './permissionLabels'

const onError = (err: unknown) => {
  if (!(err instanceof ApiError && err.code === 'reauth_required')) toast({ message: errorMessage(err) })
}

function ProfileRow({ profile }: { profile: DeviceProfile }) {
  const copy = useCopyProfile()
  const changeProfile = useChangeProfile()
  const remove = useDeleteProfile()
  const builtIn = Boolean(profile.preset)
  const name = profileName(profile)

  const askCopy = async () => {
    const newName = await promptDialog({ title: t('Copy “{name}”', { name }), label: t('Name'), initial: t('{name} (copy)', { name }), confirmLabel: t('Copy') })
    if (newName?.trim()) copy.mutate({ source_id: profile.id, name: newName.trim() }, { onError })
  }
  const askRename = async () => {
    const newName = await promptDialog({ title: t('Rename “{name}”', { name }), label: t('Name'), initial: profile.name, confirmLabel: t('Rename') })
    if (newName?.trim() && newName.trim() !== profile.name) changeProfile.mutate({ id: profile.id, name: newName.trim() }, { onError })
  }
  const askDelete = async () => {
    const ok = await confirmDialog({ title: t('Delete “{name}”?', { name }), message: t('Only a profile no device uses can be deleted.'), confirmLabel: t('Delete'), danger: true })
    if (ok) remove.mutate(profile.id, { onError })
  }

  return (
    <div className="flex flex-col gap-2 py-3" data-testid="device-profile">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium">{name}</span>
        {builtIn && <Badge>{t('built in')}</Badge>}
        <span className="text-[12px] text-muted">{plural(profile.devices, '{n} device', '{n} devices')}</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void askCopy()}>{t('Copy')}</Button>
        {!builtIn && <Button size="sm" variant="ghost" onClick={() => void askRename()}>{t('Rename')}</Button>}
        {!builtIn && <Button size="sm" variant="ghost" disabled={profile.devices > 0} onClick={() => void askDelete()}>{t('Delete')}</Button>}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        {CATEGORIES.map((c) => (
          <div key={c.key} className="flex flex-col gap-0.5">
            <span className="text-[11.5px] text-muted">{t(c.label)}</span>
            {builtIn ? (
              <span className="text-[12.5px]">{t(LEVEL_LABELS[profile.categories[c.key] ?? 'deny'])}</span>
            ) : (
              <Select variant="pill" aria-label={t('{category} in {profile}', { category: t(c.label), profile: name })} value={profile.categories[c.key] ?? 'deny'}
                disabled={changeProfile.isPending}
                onValueChange={(level) => changeProfile.mutate({ id: profile.id, categories: { ...profile.categories, [c.key]: level as CategoryLevel } }, { onError })}
                options={levelsFor(c.key).map((l) => ({ value: l, label: t(LEVEL_LABELS[l]) }))} />
            )}
          </div>
        ))}
        <div className="flex flex-col gap-0.5">
          <span className="text-[11.5px] text-muted">{t('Relevance check')}</span>
          {builtIn ? (
            <span className="text-[12.5px]">{profile.relevance_check ? t('On') : t('Off')}</span>
          ) : (
            <Switch label={t('Relevance check in {profile}', { profile: name })} checked={profile.relevance_check} disabled={changeProfile.isPending}
              onChange={(v) => changeProfile.mutate({ id: profile.id, relevance_check: v }, { onError })} />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The model of the relevance check (spec 25 §7): a separate, cheap model that may only turn an
 * allowed command into a question. Default: the background model.
 */
function RelevanceModel() {
  const settings = useSettings()
  const models = useModels()
  const save = useSaveSection('devices')
  const section = settings.data?.devices
  if (!section) return null
  const usable = (models.data ?? []).filter((m) => m.enabled && m.provider_enabled)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{t('Model of the relevance check')}</div>
        <div className="text-[12px] text-muted">
          {t('It sees only your last messages and the command, and can only turn an allowed command into a question. If it doesn’t answer in 4 seconds, the command goes ahead.')}
        </div>
      </div>
      <Select className="w-56" aria-label={t('Model of the relevance check')} value={section.relevance_model_id ?? ''}
        onValueChange={(v) => save.mutate({ ...section, relevance_model_id: v || null })}
        options={[{ value: '', label: t('The background model') }, ...usable.map((m) => ({ value: m.id, label: m.display_name }))]} />
    </div>
  )
}

/** Settings → Devices → Device profiles: the built-in presets (copy only) and your own profiles. */
export function DeviceProfilesCard() {
  const profiles = useDeviceProfiles()
  if (!profiles.data) return null
  return (
    <Card>
      <CardHeader title={t('Device profiles')}
        description={t('What agents may do on a computer. Built-in profiles can be copied, then changed; a change applies at once to every device that uses the profile, and asks for your password.')} />
      <CardBody className="flex flex-col divide-y divide-border py-1">
        {profiles.data.map((p) => <ProfileRow key={p.id} profile={p} />)}
        <RelevanceModel />
      </CardBody>
    </Card>
  )
}
