/**
 * The automation dialog's settings for its runs: which tools they see, their limits,
 * how long their chats are kept, the tools that may reach other people without asking,
 * the change check and the note the runs keep between them.
 */
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Field, Input, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { plural, t } from '@/lib/i18n'
import { useToolCatalog } from '../api'
import { parseArgs, type RunSettingsForm } from '../runSettings'

const RETENTION = ['', '1', '7', '30', '90']

interface Props {
  form: RunSettingsForm
  onChange: (form: RunSettingsForm) => void
  /** The state note is only shown for an automation that exists. */
  editing: boolean
}

export function RunSettings({ form, onChange, editing }: Props) {
  const catalog = useToolCatalog()
  const set = (patch: Partial<RunSettingsForm>) => onChange({ ...form, ...patch })
  // Tools on the list that the catalog does not know (MCP tools, say) stay on it.
  const known = (catalog.data ?? []).map((tool) => tool.name)
  const names = [...known, ...(form.tools ?? []).filter((n) => !known.includes(n))]
  const retention = RETENTION.includes(form.retentionDays) ? RETENTION : [...RETENTION, form.retentionDays]
  const toggle = (name: string, on: boolean) =>
    set({ tools: on ? [...(form.tools ?? []), name] : (form.tools ?? []).filter((n) => n !== name) })

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('Most tool calls per run')}>
          <Input inputMode="numeric" value={form.maxToolCalls} placeholder={t('The agent’s limit')}
            onChange={(e) => set({ maxToolCalls: e.target.value })} />
        </Field>
        <Field label={t('Longest run (minutes)')}>
          <Input inputMode="numeric" value={form.maxMinutes} placeholder={t('The agent’s limit')}
            onChange={(e) => set({ maxMinutes: e.target.value })} />
        </Field>
        <Field label={t('Keep run chats')}>
          <Select value={form.retentionDays} onValueChange={(v) => set({ retentionDays: v })}
            options={retention.map((d) => ({ value: d, label: d === '' ? t('Forever') : plural(Number(d), '{n} day', '{n} days') }))} />
        </Field>
      </div>

      <fieldset>
        <legend className="mb-1 text-[13px] font-medium">{t('Tools its runs may use')}</legend>
        <label className="flex items-center gap-2 rounded-control px-2 py-1.5 text-[13px] hover:bg-surface-hover">
          <input type="radio" name="tools" className="accent-[var(--accent)]" checked={form.tools === null}
            onChange={() => set({ tools: null })} />
          {t('All the tools the agent may use')}
        </label>
        <label className="flex items-center gap-2 rounded-control px-2 py-1.5 text-[13px] hover:bg-surface-hover">
          <input type="radio" name="tools" className="accent-[var(--accent)]" checked={form.tools !== null}
            onChange={() => set({ tools: form.tools ?? [] })} />
          {t('Only these:')}
        </label>
        {form.tools !== null && (
          <div className="ml-6 grid max-h-48 gap-x-3 overflow-y-auto sm:grid-cols-2">
            {names.map((name) => (
              <label key={name} className="flex min-w-0 items-center gap-2 rounded-control px-2 py-1 text-[12.5px] hover:bg-surface-hover">
                <input type="checkbox" className="accent-[var(--accent)]" checked={form.tools?.includes(name) ?? false}
                  onChange={(e) => toggle(name, e.target.checked)} />
                <span className="truncate font-mono">{name}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <Field label={t('Allowed to reach other people without asking')}
        hint={t('In automation runs, tools that send messages or emails, change something on another server or use the shell with internet always ask, whatever the permissions say. Tool names, separated by commas.')}>
        <Input value={form.contactsAllowed} spellCheck={false} placeholder="send_sms"
          onChange={(e) => set({ contactsAllowed: e.target.value })} />
      </Field>

      <fieldset>
        <legend className="text-[13px] font-medium">{t('Change check')}</legend>
        <p className="mb-2 mt-0.5 text-[12px] text-muted">
          {t('Read-only tools the server calls before each scheduled run, without the model. When their results are the same as at the last successful run, the run is skipped.')}
        </p>
        <div className="flex flex-col gap-2">
          {form.checks.map((row, i) => {
            const update = (patch: Partial<typeof row>) => set({ checks: form.checks.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
            const bad = parseArgs(row.args) === null
            return (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
                <Input aria-label={t('Tool')} value={row.tool} placeholder="list_events" spellCheck={false} list="automation-tools"
                  onChange={(e) => update({ tool: e.target.value })} />
                <Input aria-label={t('Arguments (JSON)')} value={row.args} placeholder='{"date": "today"}' spellCheck={false}
                  aria-invalid={bad} className={bad ? 'border-error' : undefined} onChange={(e) => update({ args: e.target.value })} />
                <Button variant="ghost" size="sm" icon={<Trash2 className="h-3.5 w-3.5" />} aria-label={t('Remove')}
                  onClick={() => set({ checks: form.checks.filter((_, j) => j !== i) })} />
              </div>
            )
          })}
          <datalist id="automation-tools">{known.map((n) => <option key={n} value={n} />)}</datalist>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm" icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => set({ checks: [...form.checks, { tool: '', args: '{}' }] })}>
              {t('Add a check')}
            </Button>
            {form.checks.length > 0 && (
              <label className="flex items-center gap-2 text-[13px]">
                {t('Run anyway every')}
                <Input className="h-8 w-16" inputMode="numeric" value={form.runAnywayHours}
                  onChange={(e) => set({ runAnywayHours: e.target.value })} />
                {t('hours')}
              </label>
            )}
          </div>
        </div>
      </fieldset>

      {editing && (
        <Field label={t('State note')} hint={t('What the runs keep for the next ones. Every run sees it and may replace it.')}>
          <Textarea rows={3} value={form.stateNote} maxLength={4000} onChange={(e) => set({ stateNote: e.target.value })} />
        </Field>
      )}
    </div>
  )
}
