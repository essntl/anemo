/**
 * The bar over the Git view's graph: which repository (RepoPicker), where it is read from
 * (a local checkout, or GitHub through a clone the computer keeps), the branch HEAD is on
 * and how far it is from its upstream, the working tree's changes, when it was last
 * fetched, and Refresh (fetch, then read again).
 */
import { AlertTriangle, Check, Cloud, Folder, GitBranch, PanelLeftClose, PanelLeft, RefreshCw, Trash2 } from 'lucide-react'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { useNow } from '@/hooks/useNow'
import { cn } from '@/lib/cn'
import { formatAgo, formatDateTime } from '@/lib/format'
import { plural, t } from '@/lib/i18n'
import type { CodeDevice } from '../api'
import type { GitGraph, GitRepoChoice } from './gitApi'
import { shortHash } from './gitFormat'
import { RepoPicker } from './RepoPicker'
import { AheadBehind } from './RefPills'

const CHIP = 'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium'

/** Staged, changed, untracked and conflicting files of a local checkout, or "clean". */
export function WorkingTree({ status }: { status: NonNullable<GitGraph['status']> }) {
  const parts = [
    { n: status.conflicted, label: plural(status.conflicted, '{n} conflict', '{n} conflicts'), tone: 'bg-error/12 text-error' },
    { n: status.staged, label: plural(status.staged, '{n} staged', '{n} staged'), tone: 'bg-success/12 text-success' },
    { n: status.unstaged, label: plural(status.unstaged, '{n} modified', '{n} modified'), tone: 'bg-warning/12 text-warning' },
    { n: status.untracked, label: plural(status.untracked, '{n} untracked', '{n} untracked'), tone: 'bg-surface-2 text-muted' },
  ].filter((p) => p.n > 0)
  if (!status.dirty && parts.length === 0) {
    return (
      <span className={cn(CHIP, 'bg-success/12 text-success')} title={t('No changes in the working tree')}>
        <Check aria-hidden="true" className="h-3 w-3" />{t('clean')}
      </span>
    )
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1" role="group" aria-label={t('Working tree')} title={t('Changes in the working tree, not committed yet')}>
      {parts.map((p) => <span key={p.label} className={cn(CHIP, p.tone)}>{p.label}</span>)}
    </span>
  )
}

export function GitToolbar({ devices, choice, onChoice, graph, refreshing, onRefresh, branchesOpen, onBranches, onClearCache, clearing }: {
  devices: readonly CodeDevice[]
  choice: GitRepoChoice | null
  onChoice: (choice: GitRepoChoice) => void
  graph: GitGraph | undefined
  refreshing: boolean
  onRefresh: () => void
  branchesOpen: boolean
  onBranches: () => void
  onClearCache: () => void
  clearing: boolean
}) {
  const now = useNow()
  const device = devices.find((d) => d.id === choice?.deviceId)
  const remote = choice?.repo !== undefined
  const current = graph?.branches.find((b) => b.current) ?? graph?.branches.find((b) => b.name === graph.head.branch)
  const hasRemote = (graph?.remotes.length ?? 0) > 0 || remote
  const fetched = graph?.fetchedAt ? t('Fetched {when}', { when: formatAgo(graph.fetchedAt, new Date(now)) }) : t('Never fetched')

  return (
    <div className="shrink-0 border-b border-border">
      {/* Which repository, and what can be done with it. */}
      <div className="flex min-w-0 items-center gap-2 px-3 py-2 md:px-4">
        {choice && (
          <button type="button" onClick={onBranches} aria-pressed={branchesOpen}
            aria-label={branchesOpen ? t('Hide the branches') : t('Show the branches')} title={branchesOpen ? t('Hide the branches') : t('Show the branches')}
            className="-ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:w-10">
            {branchesOpen ? <PanelLeftClose aria-hidden="true" className="h-4 w-4" /> : <PanelLeft aria-hidden="true" className="h-4 w-4" />}
          </button>
        )}
        <RepoPicker devices={devices} value={choice} onChange={onChoice} />
        {choice && (
          <span className={cn(CHIP, 'bg-surface-2 text-muted max-sm:hidden')}
            title={remote ? t('Read from a clone Anemo Desktop keeps of this GitHub repository') : t('A folder in the computer’s projects folder')}>
            {remote ? <Cloud aria-hidden="true" className="h-3 w-3" /> : <Folder aria-hidden="true" className="h-3 w-3" />}
            {remote ? t('GitHub, not cloned') : t('Local checkout')}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {graph && hasRemote && (
            <span className="hidden text-[12px] text-muted md:inline" title={graph.fetchedAt ? formatDateTime(graph.fetchedAt) : undefined}>{fetched}</span>
          )}
          {choice && (
            <button type="button" onClick={onRefresh} disabled={refreshing}
              title={hasRemote ? t('Fetch from the remote, then read the repository again') : t('Read the repository again')}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 text-[12.5px] font-medium hover:bg-surface-hover disabled:opacity-60 pointer-coarse:h-10">
              <RefreshCw aria-hidden="true" className={cn('h-3.5 w-3.5', refreshing && 'animate-spin motion-reduce:animate-none')} />
              {refreshing ? (hasRemote ? t('Fetching…') : t('Reading…')) : t('Refresh')}
            </button>
          )}
          {remote && device && (
            <ActionMenu className="h-8 w-8 pointer-coarse:h-10 pointer-coarse:w-10" label={t('More Git actions')}
              actions={[{
                label: clearing ? t('Clearing…') : t('Clear cached clones on {device}', { device: device.name }),
                icon: <Trash2 className="h-4 w-4" />,
                onSelect: onClearCache,
              }]} />
          )}
        </div>
      </div>

      {/* Where HEAD is, and the working tree. */}
      {graph && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-3 pb-2 md:px-4">
          {graph.head.detached ? (
            <span className={cn(CHIP, 'bg-warning/12 text-warning')} title={t('HEAD is detached: not on a branch')}>
              <AlertTriangle aria-hidden="true" className="h-3 w-3" />
              {t('detached at {hash}', { hash: shortHash(graph.head.commit ?? '') })}
            </span>
          ) : graph.head.branch && (
            <span className={cn(CHIP, 'bg-accent-soft text-accent')}
              title={remote ? t('The default branch on GitHub') : current?.upstream ? t('{branch}, tracking {upstream}', { branch: graph.head.branch, upstream: current.upstream }) : graph.head.branch}>
              <GitBranch aria-hidden="true" className="h-3 w-3" />
              <span className="max-w-[14rem] truncate">{graph.head.branch}</span>
              {current && <AheadBehind ahead={current.ahead} behind={current.behind} className="ml-0.5" />}
            </span>
          )}
          {current?.upstream && !remote && (
            <span className="min-w-0 truncate text-[11.5px] text-subtle">{t('tracking {upstream}', { upstream: current.upstream })}</span>
          )}
          {remote && <span className="text-[11.5px] text-subtle">{t('default branch')}</span>}
          {graph.status && <span aria-hidden="true" className="mx-1 h-3.5 w-px bg-border-strong" />}
          {graph.status && <WorkingTree status={graph.status} />}
        </div>
      )}
    </div>
  )
}
