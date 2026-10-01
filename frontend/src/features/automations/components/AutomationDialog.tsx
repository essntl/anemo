/**
 * Create or edit an automation: what the agent should do, when, as which agent,
 * and what happens with the result. Runs are unattended, so the dialog also asks
 * what to do when an action would need approval.
 */
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { browserTimeZone } from '@/features/calendar/api'
import { useDestinations } from '@/features/notifications/api'
import { useProfiles } from '@/features/profiles/api'
import { useModels } from '@/features/providers/api'
import { type Automation, type NotifyWhen, type OnAsk, useSaveAutomation, useSchedulePreview } from '../api'
import { defaultForm, fromSchedule, toSchedule } from '../scheduleForm'
import { ScheduleFields } from './ScheduleFields'

const ON_ASK_OPTIONS: { value: OnAsk; label: string }[] = [
  { value: 'pause', label: 'Wait for me, and notify me' },
  { value: 'deny', label: 'Skip that action and carry on' },
  { value: 'fail', label: 'Stop the run' },
]
const NOTIFY_OPTIONS: { value: NotifyWhen; label: string }[] = [
  { value: 'always', label: 'Every result' },
  { value: 'on_failure', label: 'Only when it fails' },
  { value: 'never', label: 'Never' },
]

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-5 border-t border-border pt-4">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {hint && <p className="mb-3 mt-0.5 text-[12px] text-muted">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </section>
  )
}

export function AutomationDialog({ automation, onClose }: { automation: Automation | null; onClose: () => void }) {
  const save = useSaveAutomation()
  const profiles = useProfiles()
  const models = useModels()
  const destinations = useDestinations()

  const [name, setName] = useState(automation?.name ?? '')
  const [prompt, setPrompt] = useState(automation?.prompt ?? '')
  const [schedule, setSchedule] = useState(() => (automation ? fromSchedule(automation.schedule) : defaultForm()))
  const [profileId, setProfileId] = useState(automation?.profile_id ?? '')
  const [modelId, setModelId] = useState(automation?.model_id ?? '')
  const [onAsk, setOnAsk] = useState<OnAsk>(automation?.on_ask ?? 'pause')
  const [notify, setNotify] = useState<NotifyWhen>(automation?.notify ?? 'always')
  // null: wherever the channels themselves are set to receive automation results.
  const [destinationIds, setDestinationIds] = useState<string[] | null>(automation?.destination_ids ?? null)
  const [documentPath, setDocumentPath] = useState(automation?.document_path ?? '')
  const [retries, setRetries] = useState(String(automation?.max_retries ?? 0))

  // Repeating schedules keep the time zone they were made in. A one-time run is
  // entered in this browser's time zone, so it is also described in it.
  const tz = schedule.frequency === 'once' ? browserTimeZone() : (automation?.schedule.tz ?? browserTimeZone())
  const preview = useSchedulePreview(toSchedule(schedule, tz))
  const usableModels = (models.data ?? []).filter((m) => m.enabled && m.provider_enabled && m.capabilities.tools)
  const channels = destinations.data ?? []
  const valid = name.trim() !== '' && prompt.trim() !== '' && preview.valid

  const submit = () =>
    save.mutate(
      {
        id: automation?.id,
        body: {
          name: name.trim(),
          prompt,
          schedule: toSchedule(schedule, tz),
          enabled: automation?.enabled ?? true,
          profile_id: profileId || null,
          model_id: modelId || null,
          on_ask: onAsk,
          notify,
          destination_ids: destinationIds,
          document_path: documentPath.trim() || null,
          max_retries: Number(retries),
        },
      },
      { onSuccess: onClose },
    )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(94vw,640px)]"
      title={automation ? `Edit “${automation.name}”` : 'New automation'}
      description="An agent does this by itself, on a schedule."
      footer={
        <>
          {save.isError && <span className="mr-auto self-center text-[12.5px] text-error">{errorMessage(save.error)}</span>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={submit}>
            {automation ? 'Save' : 'Create automation'}
          </Button>
        </>
      }>
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={name} maxLength={120} placeholder="e.g. Morning news" autoFocus={!automation}
            onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="What should it do?" hint="Written like a message to the agent. It cannot ask you questions, so say everything it needs.">
          <Textarea rows={5} value={prompt} maxLength={50_000}
            placeholder="Search for today's news about open-source AI and give me the five most important stories, each with a link."
            onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        <ScheduleFields form={schedule} onChange={setSchedule} tz={tz} preview={preview} />
      </div>

      <Section title="Agent"
        hint={<>What it may do without asking comes from the profile’s permissions (<Link to="/settings/permissions" className="text-accent underline">Agent Permissions</Link>).</>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Profile">
            <Select value={profileId} onValueChange={setProfileId}
              options={[{ value: '', label: 'Default agent' }, ...(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
          </Field>
          <Field label="Model">
            <Select value={modelId} onValueChange={setModelId}
              options={[{ value: '', label: 'Default (profile or Settings)' }, ...usableModels.map((m) => ({ value: m.id, label: m.display_name }))]} />
          </Field>
          <Field label="If an action needs my approval" hint="Nobody is there when it runs. It is never approved automatically.">
            <Select value={onAsk} options={ON_ASK_OPTIONS} onValueChange={(v) => setOnAsk(v as OnAsk)} />
          </Field>
          <Field label="If a run fails" hint="For example when the model provider is down.">
            <Select value={retries} onValueChange={setRetries}
              options={[
                { value: '0', label: 'Do not retry' },
                { value: '1', label: 'Retry once' },
                { value: '2', label: 'Retry twice' },
                { value: '3', label: 'Retry 3 times' },
              ]} />
          </Field>
        </div>
      </Section>

      <Section title="Result" hint="The agent’s final answer. Every run can also be opened from the automation’s history.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Notify me">
            <Select value={notify} options={NOTIFY_OPTIONS} onValueChange={(v) => setNotify(v as NotifyWhen)} />
          </Field>
          <Field label="Save as a document (optional)" hint="A path in Documents. {date} and {time} are filled in; the same path is replaced.">
            <Input value={documentPath} maxLength={300} placeholder="briefings/{date}" spellCheck={false}
              onChange={(e) => setDocumentPath(e.target.value)} />
          </Field>
        </div>
        {notify !== 'never' && channels.length > 0 && (
          <fieldset className="mt-3">
            <legend className="mb-1 text-[13px] font-medium">Besides the app, send to</legend>
            <label className="flex items-center gap-2 rounded-control px-2 py-1.5 text-[13px] hover:bg-surface-hover">
              <input type="radio" name="destinations" className="accent-[var(--accent)]" checked={destinationIds === null}
                onChange={() => setDestinationIds(null)} />
              The channels set to receive automation results
            </label>
            <label className="flex items-center gap-2 rounded-control px-2 py-1.5 text-[13px] hover:bg-surface-hover">
              <input type="radio" name="destinations" className="accent-[var(--accent)]" checked={destinationIds !== null}
                onChange={() => setDestinationIds([])} />
              Only these:
            </label>
            {destinationIds !== null && (
              <div className="ml-6 flex flex-col">
                {channels.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 rounded-control px-2 py-1.5 text-[13px] hover:bg-surface-hover">
                    <input type="checkbox" className="accent-[var(--accent)]" checked={destinationIds.includes(c.id)}
                      onChange={(e) => setDestinationIds(e.target.checked ? [...destinationIds, c.id] : destinationIds.filter((id) => id !== c.id))} />
                    {c.name}
                    {!c.enabled && <span className="text-subtle">(off)</span>}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        )}
        {notify !== 'never' && destinations.isSuccess && channels.length === 0 && (
          <p className="mt-3 text-[12.5px] text-muted">
            Notifications appear in the app. To also get them on your phone, add a Discord channel in{' '}
            <Link to="/settings/notifications" className="text-accent underline">Settings</Link>.
          </p>
        )}
      </Section>
    </Dialog>
  )
}
