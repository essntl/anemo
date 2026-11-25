/**
 * Automations: prompts an agent runs by itself on a schedule (and, in their own tab,
 * scripts: code that runs without a model). Each card shows
 * when it runs next and how the last run went; its history (the run log) lists past
 * runs with their outcome, what they changed and how long they took (shown as the chat
 * shows an answer's duration). `?automation=<id>&run=<run id>` opens
 * that automation's run log at that run (links to what an automation did).
 */
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ChevronDown, Clock, Code2, History, LayoutTemplate, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { Segmented } from '@/components/ui/Segmented'
import { Switch } from '@/components/ui/Switch'
import { useSaveSection, useSettings } from '@/features/settings/api'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { formatUpcoming, formatWhen } from '@/lib/format'
import { plural, rich, t } from '@/lib/i18n'
import {
  type Automation,
  STATUS_LABELS,
  STATUS_TONES,
  useAutomations,
  useDeleteAutomation,
  useRunAutomation,
  useSetAutomationEnabled,
} from './api'
import { AutomationDialog } from './components/AutomationDialog'
import { RunHistory } from './components/RunHistory'
import { ScriptDialog } from './components/ScriptDialog'
import { ScriptsTab } from './components/ScriptsTab'
import { type AutomationTemplate, TEMPLATES } from './templates'
import { Lingering } from '@/components/ui/Lingering'
import { PageHeader } from '@/components/ui/PageHeader'

function AutomationCard({ automation, onEdit, highlight }: { automation: Automation; onEdit: () => void; highlight?: string | null }) {
  const setEnabled = useSetAutomationEnabled()
  const runNow = useRunAutomation()
  const remove = useDeleteAutomation()
  // `highlight` is set when a link pointed here (undefined: none did).
  const [showHistory, setShowHistory] = useState(highlight !== undefined)
  const pending = automation.pending_approvals ?? []
  const running = automation.active_run_id !== null
  const status = automation.last_status
  const error = setEnabled.error ?? runNow.error ?? remove.error

  const confirmDelete = async () => {
    const ok = await confirmDialog({
      title: t('Delete “{name}”?', { name: automation.name }),
      message: t('The automation and the conversations of its past runs are deleted. Documents and files it made are kept.'),
      confirmLabel: t('Delete'),
      danger: true,
    })
    if (ok) remove.mutate(automation.id)
  }

  return (
    <div className={cn('rounded-card border border-border bg-card px-(--item-x) py-(--item-y) shadow-soft', !automation.enabled && 'opacity-80')}>
      <div className="flex items-start gap-3">
        <div className="pt-1">
          <Switch label={t('Run “{name}” on schedule', { name: automation.name })} checked={automation.enabled}
            onChange={(enabled) => setEnabled.mutate({ id: automation.id, enabled })} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 break-words text-[15px] font-semibold">{automation.name}</h2>
            {status && <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{t(STATUS_LABELS[status] ?? status)}</Badge>}
            {automation.created_by === 'agent' && <Badge tone="neutral">{t('Set up by the assistant')}</Badge>}
          </div>
          <p className="mt-0.5 text-[13px] text-muted">
            {automation.schedule_text}
            {automation.enabled && automation.next_run_at && <> <span className="whitespace-nowrap">· {t('next {when}', { when: formatUpcoming(automation.next_run_at) })}</span></>}
            {!automation.enabled && <> · {t('off')}</>}
            {automation.last_run_at && <> · {t('last ran {when}', { when: formatWhen(automation.last_run_at) })}</>}
          </p>
          <p className="mt-(--item-gap) line-clamp-2 whitespace-pre-wrap break-words text-[13px] text-subtle">{automation.prompt}</p>
          {(automation.failure_streak ?? 0) > 0 && automation.last_error && (
            <p className="mt-1.5 break-words text-[12.5px] text-error">
              {plural(automation.failure_streak ?? 0, 'Failed {n} time in a row: {error}', 'Failed {n} times in a row: {error}', { error: automation.last_error })}
            </p>
          )}
        </div>
        <ActionMenu actions={[
          { label: t('Edit'), icon: <Pencil />, onSelect: onEdit },
          { label: t('Delete'), icon: <Trash2 />, danger: true, onSelect: () => void confirmDelete() },
        ]} />
      </div>
      {/* Under the text on wider screens; from the card's edge on a phone, so the buttons fit one line. */}
      <div className="mt-(--item-gap) flex flex-wrap items-center gap-2 sm:pl-12">
        <Button size="sm" variant="secondary" icon={<Play className="h-3.5 w-3.5" />} disabled={running}
          loading={runNow.isPending} onClick={() => runNow.mutate(automation.id)}>
          {t('Run now')}
        </Button>
        <Button size="sm" variant="ghost" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}
          icon={<History className="h-3.5 w-3.5" />}>
          {t('History')}
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showHistory && 'rotate-180')} />
        </Button>
        {running && automation.active_run_id && status !== 'waiting' && (
          <Link to={`/runs/${automation.active_run_id}`} className="text-[13px] text-accent hover:underline">
            {t('Watch it work')}
          </Link>
        )}
        {pending.length > 0 && (
          <Link to={pending[0].conversation_id ? `/c/${pending[0].conversation_id}` : `/runs/${pending[0].run_id}`}
            className="text-[13px] text-accent hover:underline">
            {pending.length === 1 ? t('Review and approve') : plural(pending.length, '{n} approval waiting', '{n} approvals waiting')}
          </Link>
        )}
      </div>
      {error && <p className="mt-2 text-[12.5px] text-error sm:pl-12">{errorMessage(error)}</p>}
      {showHistory && <div className="mt-2 border-t border-border pt-2 md:pl-10"><RunHistory automation={automation} highlight={highlight ?? null} /></div>}
    </div>
  )
}

/** "New automation", with the templates in a menu beside it once the list has items. */
function NewAutomationButton({ label, small, templates, onNew }: {
  label: string
  /** The smaller size, for a phone's top bar. */
  small?: boolean
  templates: AutomationTemplate[]
  onNew: (template?: AutomationTemplate) => void
}) {
  const button = (
    <Button variant="primary" size={small ? 'sm' : 'md'} icon={<Plus className="h-4 w-4" />} aria-label={t('New automation')} onClick={() => onNew()}
      className={cn(templates.length > 0 && 'rounded-r-none')}>
      {label}
    </Button>
  )
  if (templates.length === 0) return button
  return (
    <div className="flex items-center">
      {button}
      <ActionMenu label={t('Start from a template')} heading={t('Start from a template')} icon={<ChevronDown className="h-4 w-4" />}
        className={cn('w-9 rounded-l-none border-l border-accent-contrast/25 bg-accent text-accent-contrast shadow-soft hover:bg-accent-hover hover:text-accent-contrast',
          small ? 'h-8 pointer-coarse:h-10' : 'h-10 pointer-coarse:h-11')}
        actions={templates.map((tpl) => ({ label: t(tpl.name), icon: <LayoutTemplate />, onSelect: () => onNew(tpl) }))} />
    </div>
  )
}

/** Templates as small buttons, under the empty list's own "New automation". */
function TemplateChoices({ templates, onPick }: { templates: AutomationTemplate[]; onPick: (tpl: AutomationTemplate) => void }) {
  return (
    <section className="mt-5 flex flex-col items-center gap-2" aria-label={t('Templates')}>
      <h4 className="text-[12.5px] text-muted">{t('Or start from a template')}</h4>
      <div className="flex flex-wrap justify-center gap-2">
        {templates.map((tpl) => (
          <Button key={tpl.name} variant="secondary" size="sm" icon={<LayoutTemplate className="h-3.5 w-3.5" />} onClick={() => onPick(tpl)}>
            {t(tpl.name)}
          </Button>
        ))}
      </div>
    </section>
  )
}

/**
 * The page is one column: the title with the New button (which follows the tab), the
 * description, the tabs, then the list. On a phone the title and the button are in the
 * app's top bar, which is that column's width there anyway.
 */
export function AutomationsPage() {
  const automations = useAutomations()
  // null: closed. { automation: null }: creating one.
  const [editing, setEditing] = useState<{ automation: Automation | null; template?: AutomationTemplate } | null>(null)
  const [editingScript, setEditingScript] = useState<{ automation: Automation | null } | null>(null)
  const settings = useSettings()
  const saveProtections = useSaveSection('automations')
  const desktop = useMediaQuery(DESKTOP)
  const [params, setParams] = useSearchParams()
  const linked = params.get('automation')
  const protections = settings.data?.automations
  const paused = protections?.paused ?? false
  const all = automations.data ?? []
  // Scripts have a tab of their own; a link to one opens that tab.
  const linkedKind = all.find((a) => a.id === linked)?.kind
  const tab: 'agent' | 'script' = params.get('tab') === 'scripts' || linkedKind === 'script' ? 'script' : 'agent'
  const setTab = (next: 'agent' | 'script') => setParams(next === 'script' ? { tab: 'scripts' } : {}, { replace: true })
  const items = all.filter((a) => a.kind !== 'script')
  const scripts = all.filter((a) => a.kind === 'script')
  const templates = TEMPLATES.filter((tpl) => !items.some((a) => a.name === tpl.name || a.name === t(tpl.name)))
  // A template fills the dialog in the user's language.
  const newAutomation = (tpl?: AutomationTemplate) =>
    setEditing({ automation: null, template: tpl && { ...tpl, name: t(tpl.name), prompt: t(tpl.prompt) } })
  const newScript = () => setEditingScript({ automation: null })
  const empty = automations.isSuccess && (tab === 'agent' ? items : scripts).length === 0

  // The New button follows the tab; a phone's top bar has room for a short, smaller one.
  // While the list is empty the button is in the empty state instead, so it isn't shown twice.
  const newButton = tab === 'script'
    ? (
        <Button variant="primary" size={desktop ? 'md' : 'sm'} icon={<Plus className="h-4 w-4" />} aria-label={t('New script')} onClick={newScript}>
          {desktop ? t('New script') : t('New##automation')}
        </Button>
      )
    : <NewAutomationButton label={desktop ? t('New automation') : t('New##automation')} small={!desktop} templates={templates} onNew={newAutomation} />

  return (
    <div className="mx-auto max-w-3xl p-4 md:px-8 md:pb-8 md:pt-1">
      {/* On a phone the button sits in the top bar: a little in from its edge, like the title. */}
      <PageHeader title={t('Automations')} inline={desktop}>{!empty && (desktop ? newButton : <div className="mr-2">{newButton}</div>)}</PageHeader>
      {/* The tabs come first and stay put; what each tab is about is said under them. */}
      <Segmented kind="tabs" controls="automations-tab" label={t('Kind of automation')} value={tab} onChange={setTab} className="mb-3"
        options={[
          { value: 'agent', label: t('Automations##agent') },
          { value: 'script', label: scripts.some((s) => s.script_pending) ? <>{t('Scripts')} <span className="text-warning">●</span></> : t('Scripts'), ariaLabel: t('Scripts') },
        ]} />
      <p className="mb-4 max-w-2xl text-[13px] text-muted">
        {tab === 'agent'
          ? rich('Things an agent does by itself on a schedule, and reports back as a <a>notification</a>.', { a: (c) => <Link to="/notifications" className="text-accent underline">{c}</Link> })
          : t('Scripts are code that runs without a model and acts only through Anemo’s tools, with the same permissions and approvals. Code an assistant writes or changes stays off until you approve it here.')}
      </p>

      {/* One switch for every schedule, automations and scripts alike; laid out as the cards
          below are (switch on the left), only slimmer. */}
      {protections && (all.length > 0 || paused) && (
        <div className={cn('mb-3 flex items-start gap-3 rounded-card border px-(--item-x) py-(--item-y)', paused ? 'border-warning bg-surface-2' : 'border-border bg-card/60')}>
          <div className="pt-0.5">
            <Switch label={t('Pause all automations and scripts')} checked={paused}
              onChange={(next) => saveProtections.mutate({ ...protections, paused: next })} />
          </div>
          <div className="min-w-0 flex-1 text-[13px]">
            <div className="flex items-center gap-1.5 font-medium">
              {paused && <Pause className="h-3.5 w-3.5 text-warning" aria-hidden />}
              {paused ? t('All automations and scripts are paused') : t('Pause all automations and scripts')}
            </div>
            <div className="text-[12.5px] text-muted">
              {paused
                ? t('Nothing starts on a schedule until you resume. A run that is going on finishes.')
                : t('Stops every schedule from starting, without switching them off one by one. A scheduled run is stopped after {minutes} minutes.', { minutes: protections.max_run_minutes })}
            </div>
          </div>
        </div>
      )}
      {saveProtections.isError && <p className="mb-2 text-[13px] text-error">{errorMessage(saveProtections.error)}</p>}
      {automations.isError && <p className="text-[13px] text-error">{errorMessage(automations.error)}</p>}

      {tab === 'script' && (
        <div id="automations-tab-script" role="tabpanel">
          {empty && (
            <EmptyState compact icon={<Code2 className="h-5 w-5" />} title={t('No scripts yet')}
              description={t('Ask the assistant to write one, e.g. “every morning, turn new bookings into tasks”, or write one yourself.')}
              action={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={newScript}>{t('New script')}</Button>} />
          )}
          {automations.isSuccess && (
            <ScriptsTab scripts={scripts} linked={linked} linkedRun={params.get('run')} onEdit={(automation) => setEditingScript({ automation })} />
          )}
        </div>
      )}
      {tab === 'agent' && (
        <div id="automations-tab-agent" role="tabpanel">
          {empty && (
            <EmptyState compact icon={<Clock className="h-5 w-5" />} title={t('No automations yet')}
              description={t('For example: a news briefing every morning, a weekly summary of your open tasks, or a check that tells you when a web page changes.')}
              action={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => newAutomation()}>{t('New automation')}</Button>}>
              {templates.length > 0 && <TemplateChoices templates={templates} onPick={newAutomation} />}
            </EmptyState>
          )}
          <div className="flex flex-col gap-(--stack-gap)">
            {items.map((a) => (
              <AutomationCard key={a.id} automation={a} onEdit={() => setEditing({ automation: a })}
                highlight={a.id === linked ? params.get('run') : undefined} />
            ))}
          </div>
        </div>
      )}

      <Lingering value={editing}>{(shown) => <AutomationDialog automation={shown.automation} template={shown.template} onClose={() => setEditing(null)} />}</Lingering>
      <Lingering value={editingScript}>{(shown) => <ScriptDialog automation={shown.automation} onClose={() => setEditingScript(null)} />}</Lingering>
    </div>
  )
}
