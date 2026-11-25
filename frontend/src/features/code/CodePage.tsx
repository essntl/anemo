/**
 * Code: the Claude Code jobs that run on your computers, live
 * (docs/specs/code-sessions.md §7). From `lg` up the list and the open thread are side
 * by side; on narrower screens `/code` is the list and `/code/:jobId` the thread, with
 * a link back. The filters stay in the address across both. Plugins may add tabs beside
 * the open job (CodePluginTabs.tsx).
 */
import { useLocation, useParams } from 'react-router'
import { SquareTerminal } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { usePluginCodeTabs } from '@/features/plugins/slotData'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { withoutAgent } from './agents'
import { CodeJobList } from './CodeJobList'
import { CodePluginPanel, CodeTabs } from './CodePluginTabs'
import { JOB_TAB, useCodeTab } from './codeTab'
import { CodeThreadView } from './CodeThreadView'

export function CodePage() {
  const { jobId } = useParams()
  const { search } = useLocation()
  const tabs = usePluginCodeTabs()
  const [tab, setTab] = useCodeTab(tabs)
  const backTo = `/code${withoutAgent(search)}`
  return (
    // From `md` up the page is one panel on the ground, like the documents.
    <div className="flex h-full md:mx-3 md:mb-3 md:h-[calc(100%-0.75rem)] md:overflow-hidden md:rounded-panel md:border md:border-border md:bg-surface md:shadow-soft">
      <PageHeader title={t('Code')} />
      <aside aria-label={t('Jobs')} className={cn('h-full w-full min-w-0 shrink-0 lg:w-80 lg:border-r lg:border-border', jobId && 'max-lg:hidden')}>
        <CodeJobList jobId={jobId} />
      </aside>
      <section className={cn('flex h-full min-w-0 flex-1 flex-col', !jobId && 'max-lg:hidden')}>
        {jobId && tabs.length > 0 && <CodeTabs tabs={tabs} tab={tab} onTab={setTab} backTo={backTo} />}
        {jobId ? (
          <div className="min-h-0 flex-1">
            {tab === JOB_TAB ? (
              // A thread of its own: its own scroll position and live streams.
              <CodeThreadView key={jobId} jobId={jobId} backTo={backTo} />
            ) : (
              // Not keyed by the job: the plugin's frame stays when another job is opened.
              <CodePluginPanel tabId={tab} jobId={jobId} />
            )}
          </div>
        ) : (
          <EmptyState icon={<SquareTerminal className="h-5 w-5" />} title={t('Pick a job')}
            description={t('Choose a job on the left to follow what Claude Code does, step by step.')} />
        )}
      </section>
    </div>
  )
}
