/**
 * Event triggers on the Automations page (docs/specs/16-event-triggers.md):
 * `AutomationTriggers` lists the events that start one automation (add, edit, remove);
 * `WaitingChats` lists the wake-me triggers that wait on chats (cancel one).
 */
import { useState } from 'react'
import { Link } from 'react-router'
import { BellRing, Plus, Trash2, Webhook, Zap } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { Lingering } from '@/components/ui/Lingering'
import { cn } from '@/lib/cn'
import { formatUpcoming, formatWhen } from '@/lib/format'
import { plural, t } from '@/lib/i18n'
import { type Trigger, useDeleteTrigger, useTriggers } from '../api'
import { describeFilter, WEBHOOK } from '../triggerForm'
import { TriggerDialog } from './TriggerDialog'

function TriggerLine({ trigger, onEdit }: { trigger: Trigger; onEdit: () => void }) {
  const remove = useDeleteTrigger()
  const filter = describeFilter(trigger.filter ?? {})
  const confirmRemove = async () => {
    const ok = await confirmDialog({
      title: t('Remove this trigger?'),
      message: trigger.event_type === WEBHOOK ? t('Its webhook URL stops working.') : t('The automation no longer runs on this event.'),
      confirmLabel: t('Remove'),
      danger: true,
    })
    if (ok) remove.mutate(trigger.id)
  }
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
      {trigger.event_type === WEBHOOK ? <Webhook className="h-3.5 w-3.5 text-muted" aria-hidden /> : <Zap className="h-3.5 w-3.5 text-muted" aria-hidden />}
      <button type="button" onClick={onEdit} className={cn('min-w-0 text-left hover:underline', !trigger.enabled && 'text-muted line-through')}>
        {t(trigger.event_label)}
        {filter && <span className="text-muted"> · {filter}</span>}
      </button>
      {trigger.debounce_s > 0 && <span className="text-[12px] text-muted">{t('bursts of {s} s', { s: trigger.debounce_s })}</span>}
      {trigger.once && <Badge tone="neutral">{t('once')}</Badge>}
      {trigger.waiting && <Badge tone="accent">{t('waiting to fire')}</Badge>}
      {trigger.expires_at && <span className="text-[12px] text-muted">{t('until {when}', { when: formatUpcoming(trigger.expires_at) })}</span>}
      {trigger.fire_count > 0 && trigger.last_fired_at && (
        <span className="text-[12px] text-muted">{plural(trigger.fire_count, 'fired {n} time, last {when}', 'fired {n} times, last {when}', { when: formatWhen(trigger.last_fired_at) })}</span>
      )}
      {trigger.dropped_count > 0 && (
        <span className="text-[12px] text-warning" title={trigger.last_drop_reason ?? undefined}>
          {plural(trigger.dropped_count, '{n} dropped', '{n} dropped')}
        </span>
      )}
      <Button size="sm" variant="ghost" className="ml-auto" icon={<Trash2 className="h-3.5 w-3.5" />} aria-label={t('Remove the trigger')}
        loading={remove.isPending} onClick={() => void confirmRemove()} />
      {remove.isError && <span className="w-full text-[12px] text-error">{errorMessage(remove.error)}</span>}
    </li>
  )
}

/** The events that start this automation, under its card. */
export function AutomationTriggers({ automationId }: { automationId: string }) {
  const triggers = useTriggers()
  const mine = (triggers.data ?? []).filter((tr) => tr.automation_id === automationId)
  // null: closed; { trigger: null }: adding one.
  const [editing, setEditing] = useState<{ trigger: Trigger | null } | null>(null)
  return (
    <div className="mt-(--item-gap) sm:pl-12">
      {mine.length > 0 && (
        <section aria-label={t('Event triggers')}>
          <h3 className="mb-1 text-[12px] font-medium uppercase tracking-wide text-muted">{t('Also runs when')}</h3>
          <ul className="flex flex-col gap-1">
            {mine.map((tr) => <TriggerLine key={tr.id} trigger={tr} onEdit={() => setEditing({ trigger: tr })} />)}
          </ul>
        </section>
      )}
      <Button size="sm" variant="ghost" className="-ml-2 mt-1" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing({ trigger: null })}>
        {t('Add a trigger')}
      </Button>
      <Lingering value={editing}>{(shown) => <TriggerDialog automationId={automationId} trigger={shown.trigger} onClose={() => setEditing(null)} />}</Lingering>
    </div>
  )
}

/** Chats an assistant asked to be woken in when something happens. */
export function WaitingChats() {
  const triggers = useTriggers()
  const remove = useDeleteTrigger()
  const waiting = (triggers.data ?? []).filter((tr) => tr.kind === 'wake' && tr.enabled)
  if (waiting.length === 0) return null
  return (
    <section className="mt-6" aria-label={t('Chats waiting for an event')}>
      <h2 className="mb-1 flex items-center gap-1.5 text-[14px] font-semibold"><BellRing className="h-4 w-4 text-muted" aria-hidden />{t('Chats waiting for an event')}</h2>
      <p className="mb-2 text-[12.5px] text-muted">{t('The assistant goes on in these chats when the event happens.')}</p>
      <ul className="flex flex-col gap-1.5">
        {waiting.map((tr) => {
          const filter = describeFilter(tr.filter ?? {})
          return (
            <li key={tr.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-card border border-border bg-card px-(--item-x) py-2 text-[13px]">
              {tr.conversation_id && (
                <Link to={`/c/${tr.conversation_id}`} className="min-w-0 truncate font-medium hover:underline">{tr.conversation_title ?? t('A chat')}</Link>
              )}
              <span className="text-muted">{t(tr.event_label)}{filter && ` · ${filter}`}</span>
              {tr.expires_at && <span className="text-[12px] text-muted">{t('until {when}', { when: formatUpcoming(tr.expires_at) })}</span>}
              {tr.note && <span className="w-full truncate text-[12px] text-subtle" title={tr.note}>{tr.note}</span>}
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => remove.mutate(tr.id)}>{t('Stop waiting')}</Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
