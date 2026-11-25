/**
 * Plugins' tabs on the Code page (plugin contract §3, `code.panel`): a row of tabs over the
 * open job, "Job" (the thread, Anemo's own) first and one per plugin panel after it. A
 * plugin tab shows its frame for the job's computer and project; it stays while another
 * job is opened (the frame gets `context.changed`, it isn't reloaded) and hears of the
 * project's jobs (`code.job`, codeJobNotices.ts). With no plugin panels there is no row
 * at all, and without an open job there are no tabs: the page's own empty state shows.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { ArrowLeft, SquareTerminal } from 'lucide-react'
import { NamedIcon, PluginIcon } from '@/features/plugins/PluginIcon'
import { type CodePanelContext, PluginCodePanel } from '@/features/plugins/slots'
import type { PluginCodeTab } from '@/features/plugins/slotData'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { useCodeJob } from './api'
import { type CodeSelection, watchProjectJobs } from './codeJobNotices'
import { JOB_TAB } from './codeTab'

/** The row of tabs over the open job. `backTo`: the list, for narrow screens (the thread's own bar has it on the job tab). */
export function CodeTabs({ tabs, tab, onTab, backTo }: { tabs: readonly PluginCodeTab[]; tab: string; onTab: (tab: string) => void; backTo: string }) {
  const location = useLocation()
  const all = [{ id: JOB_TAB, label: t('Job'), icon: null, iconUrl: null }, ...tabs]
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-1.5 md:px-4">
      {tab !== JOB_TAB && (
        <Link to={backTo} state={location.state} aria-label={t('All jobs')} title={t('All jobs')}
          className="-ml-1 inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:min-w-10 lg:hidden">
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        </Link>
      )}
      <div role="tablist" aria-label={t('What to show of this job')} className="flex min-w-0 max-w-full overflow-x-auto rounded-lg bg-surface-2 p-0.5">
        {all.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => onTab(item.id)}
            // A plugin's own title is shown as it is (plugin texts aren't translated).
            title={item.label}
            className={cn('flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors pointer-coarse:h-9 pointer-coarse:text-[13.5px]',
              tab === item.id ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}>
            {item.id === JOB_TAB
              ? <SquareTerminal aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              : <NamedIcon name={item.icon} className="h-3.5 w-3.5 shrink-0" fallback={<PluginIcon url={item.iconUrl} size={14} className="rounded-[4px]" />} />}
            <span className="max-w-40 truncate">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

const sameSelection = (a: CodeSelection | null, b: CodeSelection | null): boolean =>
  a?.deviceId === b?.deviceId && a?.device === b?.device && a?.project === b?.project && a?.jobId === b?.jobId

/**
 * A plugin's tab for the open job: its frame, about the job's computer and project. While
 * another job loads, the last one's stays (so the frame isn't drawn again).
 */
export function CodePluginPanel({ tabId, jobId }: { tabId: string; jobId: string }) {
  const job = useCodeJob(jobId).data?.job
  const current: CodeSelection | null = job ? { deviceId: job.device.id, device: job.device.name, project: job.project, jobId: job.id } : null
  const [shown, setShown] = useState(current)
  if (current && !sameSelection(current, shown)) setShown(current)

  // code.job for the project shown now (read at each notice: the frame outlives a selection).
  const selection = useRef(shown)
  useLayoutEffect(() => {
    selection.current = shown
  })
  const events = useCallback(
    (emit: (event: string, data: unknown) => void) => watchProjectJobs(() => selection.current, (event) => emit('code.job', event)),
    [],
  )

  if (!shown) return <div aria-busy className="m-3 h-64 animate-pulse rounded-card bg-surface-2 motion-reduce:animate-none" />
  const context: CodePanelContext = { code: { device: shown.device, project: shown.project, jobId: shown.jobId } }
  return (
    <div role="tabpanel" className="h-full min-h-0 p-2 md:p-3">
      <PluginCodePanel tabId={tabId} context={context} events={events} />
    </div>
  )
}
