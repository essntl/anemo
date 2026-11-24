/**
 * The Scripts tab of the Automations page: automations whose runs execute code instead
 * of asking a model, mostly written by an assistant. Each card says who wrote it, whether
 * a change waits for review, and has the switch (only for approved code with no change
 * waiting), Run now, the run log and Review (the code, or the diff of a change).
 */
import { useState } from 'react'
import { Link } from 'react-router'
import { ChevronDown, Code2, FileCode, History, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { Lingering } from '@/components/ui/Lingering'
import { Switch } from '@/components/ui/Switch'
import { cn } from '@/lib/cn'
import { formatUpcoming, formatWhen } from '@/lib/format'
import { t } from '@/lib/i18n'
import {
  type Automation,
  STATUS_LABELS,
  STATUS_TONES,
  useDeleteAutomation,
  useRunAutomation,
  useScript,
  useSetAutomationEnabled,
} from '../api'
import { RunHistory } from './RunHistory'
import { ScriptDialog } from './ScriptDialog'
import { ScriptReviewDialog } from './ScriptReviewDialog'

/** Who wrote the script: you, the assistant in a chat (a link to it), or an automation. */
function Owner({ automation }: { automation: Automation }) {
  const script = useScript(automation.id)
  const owner = script.data?.owner
  if (!owner) return null
  const label = owner.kind === 'user' ? t('Written by you') : owner.kind === 'chat'
    ? t('Written by the assistant in “{chat}”', { chat: owner.label })
    : t('Written by the automation “{name}”', { name: owner.label })
  return owner.url ? <Link to={owner.url} className="text-accent hover:underline">{label}</Link> : <span>{label}</span>
}

function ScriptCard({ automation, onEdit, onReview, highlight }: {
  automation: Automation
  onEdit: () => void
  onReview: () => void
  highlight?: string | null
}) {
  const setEnabled = useSetAutomationEnabled()
  const runNow = useRunAutomation()
  const remove = useDeleteAutomation()
  const [showHistory, setShowHistory] = useState(highlight !== undefined)
  const approved = automation.script_approved ?? false
  const waiting = automation.script_pending ?? false
  const running = automation.active_run_id !== null
  const status = automation.last_status
  const pendingApprovals = automation.pending_approvals ?? []
  const error = setEnabled.error ?? runNow.error ?? remove.error
  // Only approved code with no change waiting can be switched on (switching off always works).
  const blocked = !automation.enabled && (!approved || waiting)
  const why = !approved ? t('Approve the code first') : waiting ? t('Review the change first') : undefined

  const confirmDelete = async () => {
    const ok = await confirmDialog({
      title: t('Delete “{name}”?', { name: automation.name }),
      message: t('The script, its code, its secrets and the conversations of its past runs are deleted.'),
      confirmLabel: t('Delete'),
      danger: true,
    })
    if (ok) remove.mutate(automation.id)
  }

  return (
    <div className={cn('rounded-card border border-border bg-card px-4 py-3 shadow-soft', !automation.enabled && 'opacity-90')}
      data-testid="script-card">
      <div className="flex items-start gap-3">
        <div className="pt-1" title={blocked ? why : undefined}>
          <Switch label={t('Run “{name}”', { name: automation.name })} checked={automation.enabled} disabled={blocked}
            onChange={(enabled) => setEnabled.mutate({ id: automation.id, enabled })} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 break-words text-[15px] font-semibold">{automation.name}</h2>
            {waiting && <Badge tone="warning">{approved ? t('Change waiting for review') : t('Waiting for your review')}</Badge>}
            {status && <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{t(STATUS_LABELS[status] ?? status)}</Badge>}
          </div>
          <p className="mt-0.5 text-[13px] text-muted">
            {automation.schedule_text}
            {automation.enabled && automation.next_run_at && <> · {t('next {when}', { when: formatUpcoming(automation.next_run_at) })}</>}
            {!automation.enabled && <> · {t('off')}</>}
            {automation.last_run_at && <> · {t('last ran {when}', { when: formatWhen(automation.last_run_at) })}</>}
          </p>
          {automation.prompt !== automation.name && (
            <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-[13px] text-subtle">{automation.prompt}</p>
          )}
          <p className="mt-1 text-[12.5px] text-muted"><Owner automation={automation} /></p>
          {blocked && why && <p className="mt-1 text-[12.5px] text-muted">{why}</p>}
          {(automation.failure_streak ?? 0) > 0 && automation.last_error && (
            <p className="mt-1.5 break-words text-[12.5px] text-error">{automation.last_error}</p>
          )}
        </div>
        <ActionMenu actions={[
          { label: t('Edit'), icon: <Pencil />, onSelect: onEdit },
          { label: t('Delete'), icon: <Trash2 />, danger: true, onSelect: () => void confirmDelete() },
        ]} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-12">
        <Button size="sm" variant={waiting ? 'primary' : 'secondary'} icon={<FileCode className="h-3.5 w-3.5" />} onClick={onReview}>
          {waiting ? t('Review change') : t('Code')}
        </Button>
        <Button size="sm" variant="secondary" icon={<Play className="h-3.5 w-3.5" />} disabled={running || !approved}
          loading={runNow.isPending} onClick={() => runNow.mutate(automation.id)}>
          {t('Run now')}
        </Button>
        <Button size="sm" variant="ghost" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}
          icon={<History className="h-3.5 w-3.5" />}>
          {t('History')}
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showHistory && 'rotate-180')} />
        </Button>
        {pendingApprovals.length > 0 && (
          <Link to={pendingApprovals[0].conversation_id ? `/c/${pendingApprovals[0].conversation_id}` : `/runs/${pendingApprovals[0].run_id}`}
            className="text-[13px] text-accent hover:underline">
            {t('Review and approve')}
          </Link>
        )}
      </div>
      {error && <p className="mt-2 pl-12 text-[12.5px] text-error">{errorMessage(error)}</p>}
      {showHistory && <div className="mt-2 border-t border-border pt-2 md:pl-10"><RunHistory automation={automation} highlight={highlight ?? null} /></div>}
    </div>
  )
}

export function ScriptsTab({ scripts, linked, linkedRun }: { scripts: Automation[]; linked: string | null; linkedRun: string | null }) {
  // null: closed. { automation: null }: a new one.
  const [editing, setEditing] = useState<{ automation: Automation | null } | null>(null)
  const [reviewing, setReviewing] = useState<Automation | null>(null)
  const current = reviewing ? (scripts.find((s) => s.id === reviewing.id) ?? reviewing) : null

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-[13px] text-muted">
          {t('Scripts are code that runs without a model and acts only through Anemo’s tools, with the same permissions and approvals. Code an assistant writes or changes stays off until you approve it here.')}
        </p>
        <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ automation: null })}>{t('New script')}</Button>
      </div>
      {scripts.length === 0 && (
        <EmptyState icon={<Code2 className="h-5 w-5" />} title={t('No scripts yet')}
          description={t('Ask the assistant to write one, e.g. “every morning, turn new bookings into tasks”, or write one yourself.')} />
      )}
      <div className="flex flex-col gap-2">
        {scripts.map((s) => (
          <ScriptCard key={s.id} automation={s} onEdit={() => setEditing({ automation: s })} onReview={() => setReviewing(s)}
            highlight={s.id === linked ? linkedRun : undefined} />
        ))}
      </div>
      <Lingering value={editing}>{(shown) => <ScriptDialog automation={shown.automation} onClose={() => setEditing(null)} />}</Lingering>
      <Lingering value={current}>{(shown) => <ScriptReviewDialog automation={shown} onClose={() => setReviewing(null)} />}</Lingering>
    </div>
  )
}
