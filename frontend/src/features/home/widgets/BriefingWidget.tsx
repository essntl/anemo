import { Link } from 'react-router'
import { Newspaper } from 'lucide-react'
import { Markdown } from '@/components/ui/Markdown'
import { Select } from '@/components/ui/Select'
import { cn } from '@/lib/cn'
import { useAutomations } from '@/features/automations/api'
import { formatWhen } from '@/lib/format'
import { rich, t } from '@/lib/i18n'
import { useRunAnswer } from '../api'
import type { WidgetLayout } from '../layout'
import { WidgetHeader } from './parts'

/** Briefing: the latest answer of a chosen automation (e.g. a morning briefing), as Markdown. */
export function BriefingWidget({ item, onChoose }: { item: WidgetLayout; onChoose: (automationId: string | null) => void }) {
  const automations = useAutomations()
  const chosenId = item.options?.automation_id ?? null
  const chosen = automations.data?.find((a) => a.id === chosenId) ?? null
  const run = useRunAnswer(chosen?.last_run_id)
  const answer = run.data?.answer?.trim()
  return (
    <>
      <WidgetHeader title={chosen?.name ?? t('Briefing')} icon={<Newspaper />} to="/automations">
        {(automations.data?.length ?? 0) > 0 && (
          <Select variant="ghost" aria-label={t('Automation to show')} value={chosenId ?? ''} onValueChange={(v) => onChoose(v || null)}
            options={[{ value: '', label: t('Choose…') }, ...(automations.data ?? []).map((a) => ({ value: a.id, label: a.name }))]} />
        )}
      </WidgetHeader>
      <div className={cn('min-h-0 flex-1 overflow-y-auto px-4 pb-4', item.h === 1 && 'max-h-40')}>
        {automations.isSuccess && automations.data.length === 0 ? (
          <p className="text-[13px] text-muted">
            {rich('No automations yet. <a>Make one</a>, for example a morning briefing, and show its latest answer here.', { a: (c) => <Link to="/automations" className="font-medium text-accent hover:underline">{c}</Link> })}
          </p>
        ) : !chosen ? (
          <p className="text-[13px] text-muted">{t("Choose which automation's latest answer to show.")}</p>
        ) : !chosen.last_run_id ? (
          <p className="text-[13px] text-muted">{chosen.next_run_at ? t("It hasn't run yet. Next run: {when}.", { when: formatWhen(chosen.next_run_at) }) : t("It hasn't run yet. Next run: not scheduled.")}</p>
        ) : answer ? (
          <>
            <p className="mb-1 text-[11.5px] text-muted">{run.data?.ended_at ? formatWhen(run.data.ended_at) : ''}</p>
            <div className="[&_.markdown]:text-[13px] [&_.markdown]:leading-6"><Markdown text={answer} /></div>
          </>
        ) : run.isSuccess ? (
          <p className="text-[13px] text-muted">{t('The last run gave no answer.')}</p>
        ) : null}
      </div>
    </>
  )
}
