import { useState } from 'react'
import { Keyboard, LogOut, Monitor } from 'lucide-react'
import { errorMessage, type Schemas } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Input'
import { useLogout, useRevokeSession, useSessions } from '@/features/auth/api'
import { TokensCard } from '@/features/auth/TokensCard'
import { useSaveGeneral, useSettings } from '../api'
import { Select } from '@/components/ui/Select'
import { useHasKeyboard, useShortcutSheet } from '@/features/shortcuts/sheetStore'
import { dateLocale, LANGUAGES, t } from '@/lib/i18n'

type General = Schemas['GeneralSettings']

function GeneralForm({ initial }: { initial: General }) {
  const save = useSaveGeneral()
  // Parent re-mounts this form (via `key`) when the saved values change.
  const [form, setForm] = useState<General>(initial)
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)

  return (
    <Card>
      <CardHeader title={t('General')} description={t('Basic application behaviour.')} />
      <CardBody className="flex flex-col gap-4">
        <Field label={t('Language')} hint={t('The language of the menus, pages and buttons.')}>
          <Select
            aria-label={t('Language')}
            value={form.language ?? 'system'}
            onValueChange={(v) => setForm({ ...form, language: v as General['language'] })}
            options={[
              { value: 'system', label: t('Same as the browser') },
              // Each language under its own name, so it can be found from any other.
              ...LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
            ]}
          />
        </Field>
        <Field label={t('Time zone')} hint={t('IANA name, e.g. Europe/Amsterdam. Used for schedules and reminders.')}>
          <Input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
        </Field>
        <Field label={t('Default mode for new chats')}>
          <Select
            aria-label={t('Default mode for new chats')}
            value={form.default_chat_mode}
            onValueChange={(v) => setForm({ ...form, default_chat_mode: v as General['default_chat_mode'] })}
            options={[
              { value: 'chat', label: t('Chat') },
              { value: 'agent', label: t('Agent') },
            ]}
          />
        </Field>
        <Field label={t('Start page')} hint={t('What opening Anemo shows. The New chat button always starts a chat.')}>
          <Select
            aria-label={t('Start page')}
            value={form.start_page}
            onValueChange={(v) => setForm({ ...form, start_page: v as General['start_page'] })}
            options={[
              { value: 'home', label: t('Home') },
              { value: 'new_chat', label: t('New chat') },
            ]}
          />
        </Field>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={form.carry_over_daily_notes}
            onChange={(e) => setForm({ ...form, carry_over_daily_notes: e.target.checked })}
          />
          {t('Carry unticked notes in the daily note over to the next day')}
        </label>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={form.confirm_destructive_actions}
            onChange={(e) => setForm({ ...form, confirm_destructive_actions: e.target.checked })}
          />
          {t('Ask for confirmation before destructive actions in the UI')}
        </label>
        {save.isError && <p className="text-[13px] text-error">{errorMessage(save.error)}</p>}
        <div>
          <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(form)}>
            {t('Save')}
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

function SessionsCard() {
  const sessions = useSessions()
  const revoke = useRevokeSession()
  const logout = useLogout()
  return (
    <Card>
      <CardHeader title={t('Active sessions')} description={t('Browsers currently signed in to this workspace.')} />
      <CardBody className="flex flex-col divide-y divide-border py-2">
        {sessions.data?.map((s) => (
          <div key={s.id} className="flex items-center gap-3 py-3">
            <Monitor className="h-4 w-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">
                {s.user_agent ?? t('Unknown browser')}
                {s.current && <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">{t('This browser')}</span>}
              </div>
              <div className="text-[12px] text-muted">
                {t('{ip} · last active {when}', { ip: s.ip ?? t('unknown IP'), when: new Date(s.last_seen_at).toLocaleString(dateLocale()) })}
              </div>
            </div>
            {/* This browser too: on a phone this is where you sign out. */}
            <Button size="sm" variant="ghost" icon={<LogOut className="h-3.5 w-3.5" />}
              loading={s.current ? logout.isPending : false}
              onClick={() => (s.current ? logout.mutate() : revoke.mutate(s.id))}>
              {t('Sign out')}
            </Button>
          </div>
        ))}
      </CardBody>
    </Card>
  )
}

/** Where the shortcut sheet can be found without knowing to press ?. Not on touch-only devices. */
function ShortcutsCard() {
  const keyboard = useHasKeyboard()
  const setOpen = useShortcutSheet((s) => s.setOpen)
  if (!keyboard) return null
  return (
    <Card>
      <CardHeader title={t('Keyboard shortcuts')} description={t('Press ? anywhere outside a text field to see them all.')} />
      <CardBody>
        <Button icon={<Keyboard className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>{t('Show keyboard shortcuts')}</Button>
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
      <ShortcutsCard />
      <SessionsCard />
      <TokensCard />
    </div>
  )
}
