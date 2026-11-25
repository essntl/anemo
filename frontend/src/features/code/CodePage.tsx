/**
 * Code: the Claude Code jobs that run on your computers, live
 * (docs/specs/code-sessions.md §7), and the Git view of their repositories. From `lg` up
 * the list and the open thread are side by side; on narrower screens `/code` is the list,
 * `/code/:jobId` the thread and `/code/git` the Git view, each with a link back. The
 * filters stay in the address across them. Over the right side a row of tabs: the job,
 * Git, and the plugins' (CodePluginTabs.tsx).
 */
import { useLocation, useMatch, useNavigate, useParams } from 'react-router'
import { SquareTerminal } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { usePluginCodeTabs } from '@/features/plugins/slotData'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { withoutAgent } from './agents'
import { CodeJobList } from './CodeJobList'
import { CodePluginPanel, CodeTabs } from './CodePluginTabs'
import { GIT_TAB, JOB_TAB, useCodeTab } from './codeTab'
import { CodeThreadView } from './CodeThreadView'
import { GitView } from './git/GitView'

export function CodePage() {
  const { jobId } = useParams()
  const { search } = useLocation()
  const navigate = useNavigate()
  // /code/git: the Git view without a job (on a narrow screen, instead of the list).
  const gitRoute = Boolean(useMatch('/code/git'))
  const tabs = usePluginCodeTabs()
  const [chosen, setTab] = useCodeTab(tabs)
  const tab = gitRoute ? GIT_TAB : chosen
  const list = `/code${withoutAgent(search)}`
  const right = Boolean(jobId) || gitRoute

  const onTab = (next: string) => {
    setTab(next)
    // Without a job the address says whether Git is shown (/code/git) or not (/code).
    if (!jobId && (next === GIT_TAB) !== gitRoute) navigate(next === GIT_TAB ? `/code/git${withoutAgent(search)}` : list, { replace: true })
  }

  const pickJob = (
    <EmptyState icon={<SquareTerminal className="h-5 w-5" />} title={t('Pick a job')}
      description={t('Choose a job on the left to follow what Claude Code does, step by step.')} />
  )
  return (
    // From `md` up the page is one panel on the ground, like the documents.
    <div className="flex h-full md:mx-3 md:mb-3 md:h-[calc(100%-0.75rem)] md:overflow-hidden md:rounded-panel md:border md:border-border md:bg-surface md:shadow-soft">
      <PageHeader title={t('Code')} />
      <aside aria-label={t('Jobs')} className={cn('h-full w-full min-w-0 shrink-0 lg:w-80 lg:border-r lg:border-border', right && 'max-lg:hidden')}>
        <CodeJobList jobId={jobId} />
      </aside>
      <section className={cn('flex h-full min-w-0 flex-1 flex-col', !right && 'max-lg:hidden')}>
        <CodeTabs tabs={tabs} tab={tab} onTab={onTab} backTo={list} />
        <div className="min-h-0 flex-1">
          {tab === GIT_TAB ? (
            // Not keyed by the job: the repository stays when another job of it is opened.
            <div role="tabpanel" aria-label={t('Git')} className="h-full min-h-0">
              <GitView jobId={jobId} />
            </div>
          ) : !jobId ? (
            pickJob
          ) : tab === JOB_TAB ? (
            // A thread of its own: its own scroll position and live streams.
            <CodeThreadView key={jobId} jobId={jobId} backTo={list} />
          ) : (
            // Not keyed by the job: the plugin's frame stays when another job is opened.
            <CodePluginPanel tabId={tab} jobId={jobId} />
          )}
        </div>
      </section>
    </div>
  )
}
