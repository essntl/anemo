import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Switch } from '@/components/ui/Switch'
import { t } from '@/lib/i18n'
import { useSaveSection, useSettings } from '@/features/settings/api'
import { TimerSettingsForm } from './components/TimerSettingsForm'

function MusicSettingsCard() {
  const settings = useSettings()
  const save = useSaveSection('music')
  const m = settings.data?.music
  if (!m) return null
  return (
    <Card>
      <CardHeader title={t('Music')} description={t('How the player looks and what it tells you.')} />
      <CardBody className="flex flex-col divide-y divide-border py-2">
        <label className="flex items-center justify-between gap-4 py-3">
          <span>
            <span className="block text-[13.5px] font-medium">{t('Blurred cover behind the player')}</span>
            <span className="block text-[12px] text-muted">{t('On the Music page.')}</span>
          </span>
          <Switch label={t('Blurred cover behind the player')} checked={m.blur_backdrop} onChange={(v) => save.mutate({ ...m, blur_backdrop: v })} />
        </label>
        <label className="flex items-center justify-between gap-4 py-3">
          <span>
            <span className="block text-[13.5px] font-medium">{t('Show each new track')}</span>
            <span className="block text-[12px] text-muted">{t('The Island shows the title when a track starts.')}</span>
          </span>
          <Switch label={t('Show each new track')} checked={m.track_alerts} onChange={(v) => save.mutate({ ...m, track_alerts: v })} />
        </label>
        <label className="flex items-center justify-between gap-4 py-3">
          <span>
            <span className="block text-[13.5px] font-medium">{t('Keep playing in the background')}</span>
            <span className="block text-[12px] text-muted">
              {t('YouTube tracks are fetched by your Anemo server and played as plain audio, so they go on when the app is out of sight or the screen is off. Off, or when the server cannot fetch a track: YouTube’s own player, which stops then.')}
            </span>
          </span>
          <Switch label={t('Keep playing in the background')} checked={m.server_audio} onChange={(v) => save.mutate({ ...m, server_audio: v })} />
        </label>
        <label className="flex items-center justify-between gap-4 py-3">
          <span>
            <span className="block text-[13.5px] font-medium">{t('Play while focusing')}</span>
            <span className="block text-[12px] text-muted">{t('The music starts with a focus session and pauses for the breaks.')}</span>
          </span>
          <Switch label={t('Play while focusing')} checked={m.play_while_focusing} onChange={(v) => save.mutate({ ...m, play_while_focusing: v })} />
        </label>
      </CardBody>
    </Card>
  )
}

/** Settings → Focus & music. The same timer settings as on the Focus page. */
export function FocusSettingsPage() {
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title={t('Focus timer')} description={t('Lengths, breaks and sounds. They apply on every device.')} />
        <CardBody><TimerSettingsForm /></CardBody>
      </Card>
      <MusicSettingsCard />
    </div>
  )
}
