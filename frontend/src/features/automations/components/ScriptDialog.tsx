/**
 * Write a script in the app, or change one: its code and what the code may use, when it
 * runs, and what happens when a call needs approval. Code saved here is approved at once
 * (you wrote or read it), so saving it asks for the password. A new script starts off.
 */
import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { browserTimeZone } from '@/features/calendar/api'
import { msg, t } from '@/lib/i18n'
import {
  type Automation,
  type NotifyWhen,
  type OnAsk,
  type ScriptCode,
  useCreateScript,
  usePatchAutomation,
  useSaveScriptCode,
  useSchedulePreview,
  useScript,
} from '../api'
import { fromSchedule, SCRIPT_FREQUENCY_OPTIONS, toSchedule } from '../scheduleForm'
import { ScheduleFields } from './ScheduleFields'

const ON_ASK_OPTIONS: { value: OnAsk; label: string }[] = [
  { value: 'pause', label: msg('Wait for me, and notify me') },
  { value: 'deny', label: msg('Refuse that call (the script gets an error)') },
  { value: 'fail', label: msg('Stop the run') },
]
const NOTIFY_OPTIONS: { value: NotifyWhen; label: string }[] = [
  { value: 'agent_decides', label: msg('When the script sends a notification') },
  { value: 'always', label: msg('Every result') },
  { value: 'on_failure', label: msg('Only when it fails') },
  { value: 'never', label: msg('Never') },
]
const EXAMPLE = `export default async function main(input, anemo) {
  const tasks = await anemo.tasks.list({})
  anemo.log(tasks.content)
  return { outcome: "Looked at the tasks" }
}`

/** "a, b c" → ["a", "b", "c"] */
const names = (text: string) => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)

export function ScriptDialog({ automation, onClose }: { automation: Automation | null; onClose: () => void }) {
  const script = useScript(automation?.id ?? null)
  const create = useCreateScript()
  const patch = usePatchAutomation()
  const saveCode = useSaveScriptCode()
  // The newest code (what waits for review, else the approved one): saving it here approves it.
  const current = automation ? (script.data?.pending ?? script.data?.approved ?? null) : null
  const loaded = automation === null || script.isSuccess

  const [name, setName] = useState(automation?.name ?? '')
  const [description, setDescription] = useState(automation?.prompt ?? '')
  const [code, setCode] = useState<string | null>(null)
  const [tools, setTools] = useState<string | null>(null)
  const [hosts, setHosts] = useState<string | null>(null)
  const [secrets, setSecrets] = useState<string | null>(null)
  const [schedule, setSchedule] = useState(() => (automation ? fromSchedule(automation.schedule) : fromSchedule({ kind: 'manual', tz: 'UTC' })))
  const [onAsk, setOnAsk] = useState<OnAsk>(automation?.on_ask ?? 'pause')
  const [notify, setNotify] = useState<NotifyWhen>(automation?.notify ?? 'agent_decides')
  const [maxCalls, setMaxCalls] = useState(String(automation?.max_tool_calls ?? 30))
  const [maxMinutes, setMaxMinutes] = useState(String(Math.round((automation?.max_runtime_s ?? 300) / 60)))

  // Until edited, the fields show the saved version.
  const codeText = code ?? current?.code ?? (automation ? '' : EXAMPLE)
  const toolsText = tools ?? (current?.tools ?? []).join(', ')
  const hostsText = hosts ?? (current?.hosts ?? []).join(', ')
  const secretsText = secrets ?? (current?.secrets ?? []).join(', ')
  const body: ScriptCode = {
    code: codeText,
    tools: names(toolsText),
    hosts: names(hostsText).map((h) => h.toLowerCase()),
    secrets: names(secretsText),
    think_tools: current?.think_tools ?? [],
  }
  const codeChanged = automation === null || [code, tools, hosts, secrets].some((v) => v !== null)

  const tz = schedule.frequency === 'once' ? browserTimeZone() : (automation?.schedule.tz ?? browserTimeZone())
  const preview = useSchedulePreview(toSchedule(schedule, tz))
  const scheduleOk = schedule.frequency === 'manual' || preview.valid
  const calls = Number(maxCalls)
  const minutes = Number(maxMinutes)
  const valid = loaded && name.trim() !== '' && codeText.trim() !== '' && scheduleOk && calls >= 1 && minutes >= 1
  const busy = create.isPending || patch.isPending || saveCode.isPending
  const error = create.error ?? patch.error ?? saveCode.error

  const submit = async () => {
    const settings = {
      name: name.trim(),
      schedule: toSchedule(schedule, tz),
      on_ask: onAsk,
      notify,
      max_tool_calls: calls,
      max_runtime_s: minutes * 60,
    }
    try {
      if (automation === null) {
        await create.mutateAsync({ ...settings, ...body, description: description.trim(), max_retries: 0 })
      } else {
        if (codeChanged) await saveCode.mutateAsync({ id: automation.id, body })
        await patch.mutateAsync({ id: automation.id, body: { ...settings, prompt: description.trim() || settings.name } })
      }
      onClose()
    } catch {
      // Shown from the mutation's error.
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(96vw,760px)]"
      title={automation ? t('Edit “{name}”', { name: automation.name }) : t('New script')}
      description={t('Code that runs without a model and acts only through Anemo’s tools. Saving code here approves it, so it asks for your password.')}
      footer={
        <>
          {error && <span className="mr-auto self-center text-[12.5px] text-error">{errorMessage(error)}</span>}
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void submit()}>
            {automation ? t('Save') : t('Create script')}
          </Button>
        </>
      }>
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Name')}>
            <Input value={name} maxLength={120} autoFocus={!automation} placeholder={t('e.g. Booking check')}
              onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('What it does')}>
            <Input value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        {automation && current && script.data?.pending && (
          <p className="rounded-control bg-surface-2 px-3 py-2 text-[12.5px] text-muted">
            {t('This shows the change that waits for your review. Saving it here approves it as you leave it.')}
          </p>
        )}
        <Field label={t('Code (TypeScript)')} hint={t('export default async function main(input, anemo) … ; it calls tools with anemo.call(name, args).')}>
          <Textarea rows={14} value={codeText} spellCheck={false} className="font-mono text-[12.5px]" maxLength={100_000}
            onChange={(e) => setCode(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('Tools it may call')} hint={t('Names, separated by commas')}>
            <Input value={toolsText} spellCheck={false} className="font-mono text-[12.5px]" placeholder="create_task, send_notification"
              onChange={(e) => setTools(e.target.value)} />
          </Field>
          <Field label={t('Hosts it may reach')} hint={t('For anemo.fetch')}>
            <Input value={hostsText} spellCheck={false} className="font-mono text-[12.5px]" placeholder="api.example.com"
              onChange={(e) => setHosts(e.target.value)} />
          </Field>
          <Field label={t('Secrets it uses')} hint={t('Names like API_KEY; set their values in Review')}>
            <Input value={secretsText} spellCheck={false} className="font-mono text-[12.5px]"
              onChange={(e) => setSecrets(e.target.value)} />
          </Field>
        </div>
        <ScheduleFields form={schedule} onChange={setSchedule} tz={tz} preview={preview} options={SCRIPT_FREQUENCY_OPTIONS} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('If a call needs my approval')}>
            <Select value={onAsk} options={ON_ASK_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} onValueChange={(v) => setOnAsk(v as OnAsk)} />
          </Field>
          <Field label={t('Notify me')}>
            <Select value={notify} options={NOTIFY_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} onValueChange={(v) => setNotify(v as NotifyWhen)} />
          </Field>
          <Field label={t('At most this many tool calls')}>
            <Input type="number" min={1} max={500} value={maxCalls} onChange={(e) => setMaxCalls(e.target.value)} />
          </Field>
          <Field label={t('At most this many minutes')}>
            <Input type="number" min={1} max={1440} value={maxMinutes} onChange={(e) => setMaxMinutes(e.target.value)} />
          </Field>
        </div>
      </div>
    </Dialog>
  )
}
