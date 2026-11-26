/**
 * The branches of the Git view's repository, beside the graph: local ones, then the
 * remote-tracking ones, narrowed by a filter. A click selects the branch's tip in the
 * graph. On top, whether the graph shows every branch or only what HEAD can reach.
 */
import { useMemo, useState } from 'react'
import { Cloud, GitBranch, Search } from 'lucide-react'
import { Segmented } from '@/components/ui/Segmented'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import type { GitBranch as Branch } from './gitApi'
import { laneColor } from './gitFormat'
import { AheadBehind, PullRequestBadge } from './RefPills'

function Item({ branch, color, loaded, onJump }: { branch: Branch; color: number | null; loaded: boolean; onJump: (branch: Branch) => void }) {
  const Icon = branch.remote ? Cloud : GitBranch
  return (
    <li>
      <div className={cn('group flex min-w-0 items-center gap-1.5 rounded-control px-2 py-(--list-row-y) text-[12.5px] hover:bg-surface-hover',
        branch.current && 'bg-accent-soft hover:bg-accent-soft')}
        title={branch.current ? t('The current branch') : undefined}>
        <button type="button" onClick={() => onJump(branch)} disabled={!loaded}
          title={loaded ? t('Show {branch} in the graph', { branch: branch.name }) : t('{branch} isn’t in the loaded history', { branch: branch.name })}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default disabled:opacity-60">
          <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" style={{ color: color !== null ? laneColor(color) : 'var(--text-subtle)' }} />
          <span className={cn('min-w-0 truncate', branch.current ? 'font-semibold text-text' : branch.remote ? 'text-muted' : 'text-text')}>{branch.name}</span>
        </button>
        <AheadBehind ahead={branch.ahead} behind={branch.behind} className="shrink-0 text-[11px] text-muted" />
        {branch.pullRequest && <PullRequestBadge pr={branch.pullRequest} />}
      </div>
    </li>
  )
}

export function BranchList({ branches, remoteRepo, colorOf, loaded, allBranches, onAllBranches, onJump }: {
  /** A GitHub repository that isn't cloned: its branches are GitHub's, none is local. */
  remoteRepo: boolean
  branches: readonly Branch[]
  /** The colour index of a commit's line in the graph (null: not loaded). */
  colorOf: (hash: string) => number | null
  loaded: (hash: string) => boolean
  allBranches: boolean
  onAllBranches: (all: boolean) => void
  onJump: (branch: Branch) => void
}) {
  const [filter, setFilter] = useState('')
  const { local, remote } = useMemo(() => {
    const words = filter.trim().toLowerCase()
    const matching = branches.filter((b) => !words || b.name.toLowerCase().includes(words))
    const order = (a: Branch, b: Branch) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name)
    return {
      local: matching.filter((b) => !b.remote).sort(order),
      remote: matching.filter((b) => b.remote && !b.name.endsWith('/HEAD')).sort(order),
    }
  }, [branches, filter])

  const group = (title: string, list: Branch[]) => list.length > 0 && (
    <div className="mt-2 first:mt-0">
      <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">
        {title} <span className="font-normal tabular-nums">{list.length}</span>
      </h3>
      <ul>{list.map((b) => <Item key={b.name} branch={b} color={colorOf(b.commit)} loaded={loaded(b.commit)} onJump={onJump} />)}</ul>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-border p-2">
        <Segmented size="sm" label={t('Branches in the graph')} value={allBranches ? 'all' : 'current'}
          onChange={(v) => onAllBranches(v === 'all')} className="w-full"
          options={[{ value: 'all', label: t('All branches') }, { value: 'current', label: t('Current only') }]} />
        <label className="relative block">
          <span className="sr-only">{t('Filter branches')}</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('Filter branches')}
            className="h-8 w-full rounded-control border border-border bg-surface pl-7 pr-2 text-[12.5px] placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
        {group(remoteRepo ? t('On GitHub') : t('Local'), local)}
        {group(t('Remote'), remote)}
        {local.length + remote.length === 0 && (
          <p className="px-2 py-3 text-[12.5px] text-muted">{filter ? t('No branch matches “{filter}”.', { filter }) : t('No branches yet.')}</p>
        )}
      </div>
    </div>
  )
}
