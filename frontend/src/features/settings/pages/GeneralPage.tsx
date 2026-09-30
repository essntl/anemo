import { useState } from 'react'
import { LogOut, Monitor } from 'lucide-react'
import { errorMessage, type Schemas } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Input'
import { useRevokeSession, useSessions } from '@/features/auth/api'
import { useSaveGeneral, useSettings } from '../api'
import { Select } from '@/components/ui/Select'

type General = Schemas['GeneralSettings']

function GeneralForm({ initial }: { initial: General }) {
  const save = useSaveGeneral()
  // Parent re-mounts this form (via `key`) when the saved values change.
  const [form, setForm] = useState<General>(initial)
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)

  return (
    <Card>
      <CardHeader title="General" description="Basic application behaviour." />
      <CardBody className="flex flex-col gap-4">
        <Field label="Time zone" hint="IANA name, e.g. Europe/Amsterdam. Used for schedules and reminders.">
          <Input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
        </Field>
        <Field label="Default mode for new chats">
          <Select
            aria-label="Default mode for new chats"
            value={form.default_chat_mode}
            onValueChange={(v) => setForm({ ...form, default_chat_mode: v as General['default_chat_mode'] })}
            options={[
              { value: 'chat', label: 'Chat' },
              { value: 'agent', label: 'Agent' },
            ]}
          />
        </Field>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={form.confirm_destructive_actions}
            onChange={(e) => setForm({ ...form, confirm_destructive_actions: e.target.checked })}
          />
          Ask for confirmation before destructive actions in the UI
        </label>
        {save.isError && <p className="text-[13px] text-error">{errorMessage(save.error)}</p>}
        <div>
          <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(form)}>
            Save
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

function SessionsCard() {
  const sessions = useSessions()
  const revoke = useRevokeSession()
  return (
    <Card>
      <CardHeader title="Active sessions" description="Browsers currently signed in to this workspace." />
      <CardBody className="flex flex-col divide-y divide-border py-2">
        {sessions.data?.map((s) => (
          <div key={s.id} className="flex items-center gap-3 py-3">
            <Monitor className="h-4 w-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">
                {s.user_agent ?? 'Unknown browser'}
                {s.current && <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">This browser</span>}
              </div>
              <div className="text-[12px] text-muted">
                {s.ip ?? 'unknown IP'} · last active {new Date(s.last_seen_at).toLocaleString()}
              </div>
            </div>
            {!s.current && (
              <Button size="sm" variant="ghost" icon={<LogOut className="h-3.5 w-3.5" />} onClick={() => revoke.mutate(s.id)}>
                Sign out
              </Button>
            )}
          </div>
        ))}
      </CardBody>
    </Card>
  )
}

export function GeneralPage() {
  const settings = useSettings()
  return (
    <div className="flex flex-col gap-5">
      {settings.data && (
        <GeneralForm key={JSON.stringify(settings.data.general)} initial={settings.data.general} />
      )}
      <SessionsCard />
    </div>
  )
}
