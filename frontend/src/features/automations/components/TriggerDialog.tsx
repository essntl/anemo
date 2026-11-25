/**
 * Add or change one of an automation's event triggers: which event (from the server's
 * catalogue), which ones (a filter on the event's fields), how bursts are coalesced, how
 * often it may fire, once, until when. A new webhook shows its URL and its secret, this
 * once; "New secret" makes another (with the password).
 */
import { useState } from 'react'
import { Copy, KeyRound } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { toast } from '@/components/ui/toast'
import { t } from '@/lib/i18n'
import { type EventType, type Trigger, useEventCatalogue, useRotateSecret, useSaveTrigger } from '../api'
import { createBody, expiresOf, filterOf, formFrom, type TriggerForm, WEBHOOK } from '../triggerForm'

/** The URL and a secret, shown once, with buttons to copy them. */
export function WebhookSecret({ url, secret }: { url: string; secret: string | null }) {
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text)
    toast({ message: t('Copied') })
  }
  return (
    <div className="flex flex-col gap-2 rounded-control bg-surface-2 px-3 py-2 text-[12.5px]">
      <div>
        <div className="text-muted">{t('Webhook URL (POST)')}</div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all font-mono text-[12px]">{url}</code>
          <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} aria-label={t('Copy the URL')} onClick={() => copy(url)} />
        </div>
      </div>
      {secret && (
        <div>
          <div className="text-muted">{t('Signing secret: shown only now. Save it in the service that calls the webhook.')}</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[12px]">{secret}</code>
            <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} aria-label={t('Copy the secret')} onClick={() => copy(secret)} />
          </div>
        </div>
      )}
      <p className="text-muted">
        {t('Each request is signed: the header X-Anemo-Timestamp has the time in seconds, and X-Anemo-Signature is sha256= and the HMAC-SHA256 of “timestamp.body” with the secret.')}
      </p>
    </div>
  )
}

function FilterFields({ type, form, onChange }: { type: EventType; form: TriggerForm; onChange: (f: TriggerForm) => void }) {
  if (type.fields.length === 0) return null
  const set = (name: string, value: string) => onChange({ ...form, filter: { ...form.filter, [name]: value } })
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[13px] font-medium">{t('Only when')}</legend>
      <p className="-mt-1 text-[12px] text-muted">{t('Leave a field empty for any value. Commas separate values that may each match.')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {type.fields.map((f) => (
          <Field key={f.name} label={t(f.label)}>
            {f.kind === 'enum' ? (
              <Select value={form.filter[f.name] ?? ''} onValueChange={(v) => set(f.name, v)}
                options={[{ value: '', label: t('Any') }, ...(f.choices ?? []).map((c) => ({ value: c, label: c }))]} />
            ) : (
              <Input value={form.filter[f.name] ?? ''} maxLength={300} spellCheck={false}
                className={f.kind === 'id' ? 'font-mono text-[12.5px]' : undefined}
                placeholder={f.kind === 'id' ? t('an id') : undefined}
                onChange={(e) => set(f.name, e.target.value)} />
            )}
          </Field>
        ))}
      </div>
    </fieldset>
  )
}

export function TriggerDialog({ automationId, trigger, onClose }: { automationId: string; trigger: Trigger | null; onClose: () => void }) {
  const catalogue = useEventCatalogue()
  const save = useSaveTrigger()
  const rotate = useRotateSecret()
  const [form, setForm] = useState(() => formFrom(trigger))
  // A new webhook's (or a rotated) secret: shown once, then the dialog only closes.
  const [shown, setShown] = useState<{ url: string; secret: string | null } | null>(null)
  const types = catalogue.data ?? []
  const type = types.find((ty) => ty.type === form.eventType)
  // A webhook stays a webhook (its URL is set up elsewhere), and nothing else becomes one.
  const choices = trigger ? types.filter((ty) => (ty.type === WEBHOOK) === (trigger.event_type === WEBHOOK)) : types
  const valid = Boolean(type) && form.maxPerHour >= 1 && form.maxPerHour <= 120 && form.debounceS >= 0 && form.debounceS <= 3600
  const error = save.error ?? rotate.error

  const submit = () => {
    if (trigger) {
      save.mutate(
        {
          id: trigger.id,
          patch: {
            event_type: form.eventType,
            filter: filterOf(form, type),
            debounce_s: form.debounceS,
            max_per_hour: form.maxPerHour,
            once: form.once,
            expires_at: expiresOf(form),
            enabled: form.enabled,
            note: form.note.trim(),
          },
        },
        { onSuccess: onClose },
      )
      return
    }
    save.mutate({ create: createBody(automationId, form, type) }, {
      onSuccess: ({ trigger: made, secret }) => (made.webhook_url ? setShown({ url: made.webhook_url, secret }) : onClose()),
    })
  }

  if (shown) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()} title={t('Webhook ready')}
        footer={<Button variant="primary" onClick={onClose}>{t('Done')}</Button>}>
        <WebhookSecret url={shown.url} secret={shown.secret} />
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(94vw,600px)]"
      title={trigger ? t('Edit trigger') : t('New trigger')}
      description={t('When this event happens, the automation runs, with the event as data.')}
      footer={
        <>
          {error && <span className="mr-auto self-center text-[12.5px] text-error">{errorMessage(error)}</span>}
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={submit}>
            {trigger ? t('Save') : t('Add trigger')}
          </Button>
        </>
      }>
      <div className="flex flex-col gap-4">
        <Field label={t('Event')} hint={type ? t(type.description) : undefined}>
          <Select value={form.eventType} disabled={trigger?.event_type === WEBHOOK}
            onValueChange={(v) => setForm({ ...form, eventType: v, filter: {} })}
            options={choices.map((ty) => ({ value: ty.type, label: t(ty.label) }))} />
        </Field>
        {type && <FilterFields type={type} form={form} onChange={setForm} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Coalesce bursts (seconds)')} hint={t('Events within this time after the first one start one run, with the newest event.')}>
            <Input type="number" min={0} max={3600} value={form.debounceS}
              onChange={(e) => setForm({ ...form, debounceS: Math.max(0, Number(e.target.value) || 0) })} />
          </Field>
          <Field label={t('At most … runs an hour')} hint={t('More are dropped and counted here.')}>
            <Input type="number" min={1} max={120} value={form.maxPerHour}
              onChange={(e) => setForm({ ...form, maxPerHour: Number(e.target.value) || 0 })} />
          </Field>
          <Field label={t('Until')} hint={t('Empty: no end.')}>
            <Input type="datetime-local" value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox checked={form.once} onChange={(e) => setForm({ ...form, once: e.target.checked })} />
          {t('Only once (switch it off after it fired)')}
        </label>
        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          {t('On##trigger')}
        </label>
        <Field label={t('Note')} hint={t('Why it is there; the run gets it with the event.')}>
          <Textarea rows={2} maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
        {trigger?.webhook_url && (
          <div className="flex flex-col gap-2">
            <WebhookSecret url={trigger.webhook_url} secret={null} />
            <div>
              <Button size="sm" variant="secondary" icon={<KeyRound className="h-3.5 w-3.5" />} loading={rotate.isPending}
                onClick={() => rotate.mutate(trigger.id, { onSuccess: (r) => setShown({ url: r.webhook_url, secret: r.secret }) })}>
                {t('New secret')}
              </Button>
              <span className="ml-2 text-[12px] text-muted">{t('The old secret stops working at once.')}</span>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}
