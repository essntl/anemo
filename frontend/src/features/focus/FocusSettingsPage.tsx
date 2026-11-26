import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { SettingRow, SettingRows } from '@/components/ui/SettingRow'
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
      <SettingRows>
        <SettingRow title={t('Blurred cover behind the player')} description={t('On the Music page.')}
          checked={m.blur_backdrop} onCheckedChange={(v) => save.mutate({ ...m, blur_backdrop: v })} />
        <SettingRow title={t('Show each new track')} description={t('The Island shows the title when a track starts.')}
          checked={m.track_alerts} onCheckedChange={(v) => save.mutate({ ...m, track_alerts: v })} />
        <SettingRow title={t('Keep playing in the background')}
          description={t('YouTube tracks are fetched by your Anemo server and played as plain audio, so they go on when the app is out of sight or the screen is off. Off, or when the server cannot fetch a track: YouTube’s own player, which stops then.')}
          checked={m.server_audio} onCheckedChange={(v) => save.mutate({ ...m, server_audio: v })} />
        <SettingRow title={t('Play while focusing')} description={t('The music starts with a focus session and pauses for the breaks.')}
          checked={m.play_while_focusing} onCheckedChange={(v) => save.mutate({ ...m, play_while_focusing: v })} />
      </SettingRows>
    </Card>
  )
}

/** Settings → Focus & music. The same timer settings as on the Focus page. */
export function FocusSettingsPage() {
  return (
    <div className="flex flex-col gap-(--card-gap)">
      <Card>
        <CardHeader title={t('Focus timer')} description={t('Lengths, breaks and sounds. They apply on every device.')} />
        <CardBody><TimerSettingsForm /></CardBody>
      </Card>
      <MusicSettingsCard />
    </div>
  )
}
