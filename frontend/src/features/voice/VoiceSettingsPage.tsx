/** Settings → Voice: how requests spoken to a phone (Anemo Voice) are run and answered. */
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { useProfiles } from '@/features/profiles/api'
import { useModels } from '@/features/providers/api'
import { useSettings } from '@/features/settings/api'
import { msg, rich, t } from '@/lib/i18n'
import { type VoiceSettings, useSaveVoiceSettings } from './api'
import { clampInt } from './clamp'

const CHAT_OPTIONS = [
  { value: 'daily', label: msg('A new one each day') },
  { value: 'single', label: msg('One that keeps going') },
]

function Row({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium">{title}</span>
        <span className="block text-[12px] text-muted">{hint}</span>
      </span>
      {children}
    </div>
  )
}

function VoiceForm({ initial }: { initial: VoiceSettings }) {
  const save = useSaveVoiceSettings()
  const profiles = useProfiles()
  // An agent needs a model that can use tools.
  const models = (useModels().data ?? []).filter((m) => m.enabled && m.provider_enabled && m.capabilities.tools)
  const [form, setForm] = useState<VoiceSettings>(initial)
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  const set = (patch: Partial<VoiceSettings>) => setForm({ ...form, ...patch })

  return (
    <div className="flex flex-col gap-(--card-gap)">
      <Card>
        <CardHeader title={t('Voice')}
          description={t('Talk to Anemo from your phone with the Anemo Voice app: say the wake word and what you want. It runs as an agent request in a Voice chat, and the phone reads the answer out.')} />
        <CardBody className="flex flex-col divide-y divide-border py-2">
          <Row title={t('Agent for voice requests')} hint={t('Its tools and permissions apply, as in the chat.')}>
            <Select aria-label={t('Agent for voice requests')} className="w-56" value={form.profile_id ?? ''}
              onValueChange={(v) => set({ profile_id: v || null })}
              options={[{ value: '', label: t('Default agent') }, ...(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
          </Row>
          <Row title={t('Model for voice requests')}
            hint={t('A small, fast model keeps spoken answers quick and cheap. “The agent’s model” uses the agent’s own, else the Agent model in Providers & Models.')}>
            <Select aria-label={t('Model for voice requests')} className="w-56" value={form.model_id ?? ''}
              onValueChange={(v) => set({ model_id: v || null })}
              options={[{ value: '', label: t('The agent’s model') }, ...models.map((m) => ({ value: m.id, label: m.display_name }))]} />
          </Row>
          <Row title={t('The Voice chat')} hint={t('Where voice requests go when they don’t follow up on an answer.')}>
            <Select aria-label={t('The Voice chat')} className="w-56" value={form.chat}
              onValueChange={(v) => set({ chat: v as VoiceSettings['chat'] })}
              options={CHAT_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))} />
          </Row>
          <Row title={t('Follow-up window (minutes)')}
            hint={t('A request this soon after an answer continues that chat, so “and move it to Friday” knows what “it” is. 0 turns follow-ups off.')}>
            <Input type="number" min={0} max={60} className="w-24" aria-label={t('Follow-up window (minutes)')}
              value={form.follow_up_minutes} onChange={(e) => set({ follow_up_minutes: clampInt(e.target.value, 0, 60) })} />
          </Row>
          <Row title={t('Longest answer read out (characters)')}
            hint={t('A longer answer is cut at the end of a sentence, followed by “The rest is in the chat.”')}>
            <Input type="number" min={100} max={2000} step={50} className="w-24" aria-label={t('Longest answer read out (characters)')}
              value={form.max_spoken_chars} onChange={(e) => set({ max_spoken_chars: Number(e.target.value) || 0 })}
              onBlur={(e) => set({ max_spoken_chars: clampInt(e.target.value, 100, 2000) })} />
          </Row>
          <label className="flex items-center justify-between gap-4 py-3">
            <span>
              <span className="block text-[13.5px] font-medium">{t('Allow approvals by voice')}</span>
              <span className="block text-[12px] text-muted">{t('Answer “Allow?” and plan reviews with yes or no. Dangerous actions always need a tap on the notification. Off: questions are still answered by voice.')}</span>
            </span>
            <Switch label={t('Allow approvals by voice')} checked={form.approvals_by_voice} onChange={(v) => set({ approvals_by_voice: v })} />
          </label>
          <div className="flex items-center gap-3 py-3">
            <Button variant="primary" disabled={!dirty} loading={save.isPending}
              onClick={() => save.mutate({ ...form, max_spoken_chars: clampInt(String(form.max_spoken_chars), 100, 2000) })}>
              {t('Save')}
            </Button>
            {save.isError && <span className="text-[13px] text-error">{errorMessage(save.error)}</span>}
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={t('Models and phones')} />
        <CardBody>
          <p className="text-[13px] text-muted">
            {rich('Voice uses the dictation models (<link>Providers & Models</link>): <b>Transcription</b> hears the request and <b>Dictation clean-up</b> turns it into one clear instruction. The words in <dictation>Dictation</dictation> apply too. Neither the recording nor what was heard is kept; the request is saved as your chat message.', {
              link: (children) => <Link to="/settings/providers" className="text-accent hover:underline">{children}</Link>,
              dictation: (children) => <Link to="/settings/dictation" className="text-accent hover:underline">{children}</Link>,
              b: (children) => <span className="font-medium text-text">{children}</span>,
            })}
          </p>
          <p className="mt-2 text-[13px] text-muted">
            {t('The wake word, the voice the phone speaks with and the headset are set in the app on the phone.')}
          </p>
        </CardBody>
      </Card>
    </div>
  )
}

/** Settings → Voice. */
export function VoiceSettingsPage() {
  const settings = useSettings()
  const voice = settings.data?.voice
  if (!voice) return null
  return <VoiceForm key={JSON.stringify(voice)} initial={voice} />
}
