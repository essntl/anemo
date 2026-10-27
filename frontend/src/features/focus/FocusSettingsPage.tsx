import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Switch } from '@/components/ui/Switch'
import { useSaveSection, useSettings } from '@/features/settings/api'
import { TimerSettingsForm } from './components/TimerSettingsForm'

function MusicSettingsCard() {
  const settings = useSettings()
  const save = useSaveSection('music')
  const m = settings.data?.music
  if (!m) return null
  return (
    <Card>
      <CardHeader title="Music" description="How the player looks and what it tells you." />
      <CardBody className="flex flex-col divide-y divide-border py-2">
        <label className="flex items-center justify-between gap-4 py-3">
          <span>
            <span className="block text-[13.5px] font-medium">Blurred cover behind the player</span>
            <span className="block text-[12px] text-muted">On the Music page.</span>
          </span>
          <Switch label="Blurred cover behind the player" checked={m.blur_backdrop} onChange={(v) => save.mutate({ ...m, blur_backdrop: v })} />
        </label>
        <label className="flex items-center justify-between gap-4 py-3">
          <span>
            <span className="block text-[13.5px] font-medium">Show each new track</span>
            <span className="block text-[12px] text-muted">The Island shows the title when a track starts.</span>
          </span>
          <Switch label="Show each new track" checked={m.track_alerts} onChange={(v) => save.mutate({ ...m, track_alerts: v })} />
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
        <CardHeader title="Focus timer" description="Lengths, breaks and sounds. They apply on every device." />
        <CardBody><TimerSettingsForm /></CardBody>
      </Card>
      <MusicSettingsCard />
    </div>
  )
}
