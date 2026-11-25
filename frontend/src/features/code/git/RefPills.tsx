/**
 * A commit's refs as small pills (gitRefs.ts): HEAD in the accent, its branches in the
 * colour of their line, remote branches muted, tags in amber; a branch's pull request as a
 * link next to it. Long lists show the first few and "+n" (the rest in its tooltip).
 */
import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, CloudCheck, Cloud, GitBranch, GitPullRequest, GitPullRequestDraft, LocateFixed, Tag } from 'lucide-react'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { laneColor, tinted } from './gitFormat'
import type { PullRequest, RefPill } from './gitRefs'

const PILL = 'inline-flex h-[18px] min-w-0 max-w-[13rem] items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium leading-none'

/** ↑2 ↓5: how far a branch is ahead of and behind its upstream. */
export function AheadBehind({ ahead, behind, className }: { ahead: number; behind: number; className?: string }) {
  if (!ahead && !behind) return null
  const label = [ahead ? t('{n} ahead', { n: ahead }) : '', behind ? t('{n} behind', { n: behind }) : ''].filter(Boolean).join(', ')
  return (
    <span className={cn('inline-flex items-center gap-0.5 tabular-nums', className)} title={label} aria-label={label}>
      {ahead > 0 && <span className="inline-flex items-center"><ArrowUp aria-hidden="true" className="h-2.5 w-2.5" />{ahead}</span>}
      {behind > 0 && <span className="inline-flex items-center"><ArrowDown aria-hidden="true" className="h-2.5 w-2.5" />{behind}</span>}
    </span>
  )
}

/** A pull request: its number, its title on hover, a link to it on GitHub. */
export function PullRequestBadge({ pr, className }: { pr: PullRequest; className?: string }) {
  const Icon = pr.draft ? GitPullRequestDraft : GitPullRequest
  return (
    <a href={pr.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
      title={pr.draft ? t('Draft pull request #{number}: {title}', { number: pr.number, title: pr.title }) : t('Pull request #{number}: {title}', { number: pr.number, title: pr.title })}
      className={cn(PILL, 'shrink-0 hover:underline', pr.draft ? 'border-dashed border-border-strong bg-transparent text-muted' : 'border-transparent', className)}
      style={pr.draft ? undefined : tinted('var(--success)')}>
      <Icon aria-hidden="true" className="h-3 w-3 shrink-0" />#{pr.number}
    </a>
  )
}

const headTitle = (detached: boolean, remoteRepo: boolean) =>
  detached ? t('HEAD is detached: not on a branch') : remoteRepo ? t('HEAD: the default branch on GitHub') : t('HEAD: you are here, the commit checked out on the computer')

/** `head`: HEAD is on this branch: the pill starts with it ("HEAD → main", as git says). */
function Pill({ pill, color, remoteRepo, head = false }: { pill: RefPill; color: string; remoteRepo: boolean; head?: boolean }): ReactNode {
  switch (pill.kind) {
    case 'head':
      return (
        <span className={cn(PILL, 'shrink-0 border-transparent bg-accent text-accent-contrast')} title={headTitle(pill.detached, remoteRepo)}>
          <LocateFixed aria-hidden="true" className="h-3 w-3 shrink-0" />
          HEAD
          <span className="font-normal opacity-90">· {pill.detached ? t('detached') : remoteRepo ? t('default branch') : t('you are here')}</span>
        </span>
      )
    case 'branch':
      return (
        <>
          <span className={cn(PILL, 'shrink', head ? 'min-w-[9rem] overflow-hidden pl-0' : 'min-w-[3rem]', pill.current && 'font-semibold')} style={tinted(color, pill.current || head)}
            title={pill.synced ? t('{branch}, in sync with {upstream}', { branch: pill.name, upstream: pill.upstream ?? '' }) : pill.name}>
            {head && (
              <span className="-my-px mr-0.5 flex h-[18px] shrink-0 items-center gap-1 bg-accent pl-1.5 pr-1.5 text-accent-contrast" title={headTitle(false, remoteRepo)}>
                <LocateFixed aria-hidden="true" className="h-3 w-3 shrink-0" />HEAD
              </span>
            )}
            <GitBranch aria-hidden="true" className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">{pill.name}</span>
            {pill.synced && <CloudCheck aria-label={t('in sync with {upstream}', { upstream: pill.upstream ?? '' })} className="h-3 w-3 shrink-0 opacity-80" />}
            <AheadBehind ahead={pill.ahead} behind={pill.behind} className="ml-0.5 shrink-0" />
          </span>
          {pill.pullRequest && <PullRequestBadge pr={pill.pullRequest} />}
        </>
      )
    case 'remote':
      return (
        <>
          <span className={cn(PILL, 'min-w-[3rem] shrink border-border bg-surface-2 font-normal text-muted')} title={pill.name}>
            <Cloud aria-hidden="true" className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">{pill.name}</span>
          </span>
          {pill.pullRequest && <PullRequestBadge pr={pill.pullRequest} />}
        </>
      )
    case 'tag':
      return (
        <span className={cn(PILL, 'min-w-[3rem] shrink')} style={tinted('var(--git-lane-7)')} title={t('Tag {name}', { name: pill.name })}>
          <Tag aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate">{pill.name}</span>
        </span>
      )
  }
}

const keyOf = (pill: RefPill) => (pill.kind === 'head' ? 'head' : `${pill.kind}:${pill.name}`)

/** The pills of one commit. `color`: the colour index of the commit's line. */
export function RefPills({ pills, color, remoteRepo, max = 4 }: { pills: readonly RefPill[]; color: number; remoteRepo: boolean; max?: number }) {
  if (pills.length === 0) return null
  // HEAD on a branch: one pill for both.
  const fused = pills[0].kind === 'head' && !pills[0].detached && pills[1]?.kind === 'branch'
  const list = fused ? pills.slice(1) : pills
  const shown = list.slice(0, max)
  const rest = list.slice(max)
  return (
    <span className="flex min-w-0 max-w-[80%] shrink-0 items-center gap-1 overflow-hidden">
      {shown.map((pill, i) => <Pill key={keyOf(pill)} pill={pill} color={laneColor(color)} remoteRepo={remoteRepo} head={fused && i === 0} />)}
      {rest.length > 0 && (
        <span className={cn(PILL, 'shrink-0 border-border bg-surface-2 text-muted')} title={rest.map((p) => (p.kind === 'head' ? 'HEAD' : p.name)).join(', ')}>
          +{rest.length}
        </span>
      )}
    </span>
  )
}
