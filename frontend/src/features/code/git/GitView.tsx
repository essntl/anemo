/**
 * The Code page's Git view: the graph of a repository on one of your computers, read
 * there by Anemo Desktop (docs/device-contracts.md §7.5, §7.6). With a job open it shows
 * that job's project; otherwise the repository picked last (gitRepoStore.ts).
 *
 * Toolbar on top (GitToolbar), then the branches (BranchList), the commits (GitGraphList)
 * and, for the selected commit, its details (CommitPanel): beside the graph when the view
 * is wide, over it when not. It is read again when a Claude Code job of the project
 * changes state, and on Refresh (which fetches first).
 */
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CloudOff, FolderGit2, GitBranch, Info, KeyRound, Laptop, Lock, RefreshCw, SearchX, ShieldAlert, Unplug, Download } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/toast'
import { REDUCED_MOTION } from '@/features/appearance/motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { formatSize } from '@/lib/format'
import { plural, t } from '@/lib/i18n'
import { type CodeDevice, useCodeDevices, useCodeJob } from '../api'
import { watchProjectJobs } from '../codeJobNotices'
import { BranchList } from './BranchList'
import { CommitPanel } from './CommitPanel'
import { type GitBranch as Branch, type GitGraph, type GitRepoChoice, gitGraphsKey, repoLabel, useClearGitCache, useFetchGraph, useGitGraph } from './gitApi'
import { type GitErrorKind, gitErrorInfo } from './gitErrors'
import { shortHash } from './gitFormat'
import { GitGraphList, type GitGraphListHandle } from './GitGraphList'
import { layoutLanes } from './gitLanes'
import { type RefPill, refIndex, refPills } from './gitRefs'
import { GitToolbar } from './GitToolbar'
import { useGitViewStore } from './gitRepoStore'
import { useRowHeight } from './useRowHeight'

/** How many commits are read: more with each "Load more". */
const LIMITS = [300, 600, 1000] as const
const MAX_LIMIT = LIMITS[LIMITS.length - 1]
/** From this width (px) of the view, the branches stay open beside the graph. */
const WIDE_VIEW = 960

/** An element's width, kept up to date (0 until measured, or where nothing is laid out). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [ref])
  return width
}

const ERROR_ICON: Record<GitErrorKind, ReactNode> = {
  update: <Download className="h-5 w-5" />,
  offline: <Unplug className="h-5 w-5" />,
  trust: <ShieldAlert className="h-5 w-5" />,
  refused: <Lock className="h-5 w-5" />,
  signin: <KeyRound className="h-5 w-5" />,
  missing: <SearchX className="h-5 w-5" />,
  busy: <RefreshCw className="h-5 w-5" />,
  failed: <AlertTriangle className="h-5 w-5" />,
}

const choiceKey = (c: GitRepoChoice) => `${c.deviceId}:${c.repo !== undefined ? `r:${c.repo}` : `p:${c.project}`}`

/** Rows that stand in for the commits while they load. */
function SkeletonRows({ note }: { note?: string }) {
  const height = useRowHeight()
  return (
    <div aria-busy="true" aria-label={t('Loading…')} className="min-h-0 flex-1 overflow-hidden">
      {note && (
        <p className="flex items-center gap-2 border-b border-border bg-surface-2/60 px-4 py-2 text-[12.5px] text-muted" role="status">
          <RefreshCw aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />{note}
        </p>
      )}
      {Array.from({ length: 14 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3" style={{ height }}>
          <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-surface-2 motion-reduce:animate-none" style={{ marginLeft: 6 + (i % 3 === 1 ? 14 : 0) }} />
          <span className="h-3 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" style={{ width: `${30 + ((i * 37) % 45)}%` }} />
          <span className="ml-auto h-3 w-16 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  )
}

/** A line under the toolbar: a warning (amber) or a note. */
function Notice({ tone, icon, children }: { tone: 'warning' | 'info'; icon: ReactNode; children: ReactNode }) {
  return (
    <p role={tone === 'warning' ? 'alert' : 'note'}
      className={cn('flex shrink-0 items-start gap-2 border-b border-border px-4 py-1.5 text-[12.5px]',
        tone === 'warning' ? 'bg-warning/10 text-text' : 'bg-surface-2/60 text-muted')}>
      <span aria-hidden="true" className={cn('mt-0.5 shrink-0 [&_svg]:h-3.5 [&_svg]:w-3.5', tone === 'warning' ? 'text-warning' : 'text-subtle')}>{icon}</span>
      <span className="min-w-0">{children}</span>
    </p>
  )
}

export function GitView({ jobId }: { jobId?: string }) {
  const devicesQuery = useCodeDevices()
  const devices = useMemo(() => devicesQuery.data ?? [], [devicesQuery.data])
  const job = useCodeJob(jobId ?? null)
  const stored = useGitViewStore((s) => s.repo)
  const setRepo = useGitViewStore((s) => s.setRepo)
  // A repository picked while this job (or no job) was open; another job shows its own.
  const [picked, setPicked] = useState<{ jobId: string | null; choice: GitRepoChoice } | null>(null)

  const open = job.data?.job
  const jobChoice: GitRepoChoice | null = open ? { deviceId: open.device.id, project: open.project } : null
  const known = (c: GitRepoChoice | null) => (c && devices.some((d) => d.id === c.deviceId) ? c : null)
  const choice = picked && picked.jobId === (jobId ?? null) ? picked.choice : jobId ? jobChoice : known(stored)

  const choose = (c: GitRepoChoice) => {
    setRepo(c)
    setPicked({ jobId: jobId ?? null, choice: c })
  }

  if (devicesQuery.isPending || (jobId && job.isPending && !picked)) {
    return <div className="flex h-full flex-col"><div className="h-12 shrink-0 border-b border-border" /><SkeletonRows /></div>
  }
  if (devicesQuery.isError) {
    return (
      <EmptyState icon={<AlertTriangle className="h-5 w-5" />} title={t('Couldn’t load your computers')} description={errorMessage(devicesQuery.error)}
        action={<Button size="sm" onClick={() => void devicesQuery.refetch()}>{t('Try again')}</Button>} />
    )
  }
  if (devices.length === 0) {
    return (
      <EmptyState icon={<Laptop className="h-5 w-5" />} title={t('No computers yet')}
        description={t('Trust a computer with Anemo Desktop in Settings → Devices, and the repositories on it can be shown here.')}
        action={<Link to="/settings/devices"><Button size="sm">{t('Open Devices')}</Button></Link>} />
    )
  }
  return choice ? (
    <RepoGraph key={choiceKey(choice)} choice={choice} devices={devices} onChoice={choose} />
  ) : (
    <div className="flex h-full flex-col">
      <GitToolbar devices={devices} choice={null} onChoice={choose} graph={undefined} refreshing={false} onRefresh={() => {}}
        branchesOpen={false} onBranches={() => {}} onClearCache={() => {}} clearing={false} />
      <EmptyState icon={<FolderGit2 className="h-5 w-5" />} title={t('Pick a repository')}
        description={t('Choose a project on one of your computers, or a GitHub repository, to see its branches and commits.')} />
    </div>
  )
}

function RepoGraph({ choice, devices, onChoice }: { choice: GitRepoChoice; devices: readonly CodeDevice[]; onChoice: (c: GitRepoChoice) => void }) {
  const qc = useQueryClient()
  const device = devices.find((d) => d.id === choice.deviceId) as CodeDevice
  const remote = choice.repo !== undefined
  // The branches sit beside the graph when the view itself is wide (not the window: the
  // job list may take a third of it); otherwise they open over it, when asked for.
  const root = useRef<HTMLDivElement>(null)
  const roomy = useMediaQuery('(min-width: 1024px)')
  const width = useWidth(root)
  const wide = width ? width >= WIDE_VIEW : roomy
  const still = useMediaQuery(REDUCED_MOTION)
  const { allBranches, setAllBranches, branchesOpen: storedOpen, setBranchesOpen } = useGitViewStore()
  // On a narrow screen the branches are over the graph, closed until asked for.
  const [narrowOpen, setNarrowOpen] = useState(false)
  const branchesOpen = wide ? storedOpen : narrowOpen
  const [limit, setLimit] = useState<number>(LIMITS[0])
  const options = { limit, all: allBranches }
  const query = useGitGraph(choice, options)
  const refresh = useFetchGraph(choice, options)
  const clear = useClearGitCache()
  const graph: GitGraph | undefined = query.data
  const list = useRef<GitGraphListHandle>(null)

  const [selected, setSelected] = useState<string | null>(null)
  const [panel, setPanel] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

  // A Claude Code job of this project started or ended: read the graph again.
  const deviceName = device?.name ?? ''
  useEffect(() => {
    if (remote) return
    return watchProjectJobs(
      () => ({ deviceId: choice.deviceId, device: deviceName, project: choice.project ?? '', jobId: null }),
      () => void qc.invalidateQueries({ queryKey: gitGraphsKey(choice) }),
    )
  }, [qc, choice, remote, deviceName])

  useEffect(() => {
    if (!flash) return
    const timer = window.setTimeout(() => setFlash(null), 2200)
    return () => window.clearTimeout(timer)
  }, [flash])

  const commits = useMemo(() => graph?.commits ?? [], [graph])
  const layout = useMemo(() => layoutLanes(commits), [commits])
  const rowOf = useMemo(() => new Map(commits.map((c, i) => [c.hash, i])), [commits])
  const pills = useMemo(() => {
    const out = new Map<string, RefPill[]>()
    if (!graph) return out
    const index = refIndex({ branches: graph.branches, remotes: graph.remotes.map((r) => r.name) })
    for (const c of graph.commits) {
      if (c.refs.length) out.set(c.hash, refPills(c.refs, index, graph.head.detached && c.hash === graph.head.commit))
    }
    return out
  }, [graph])

  const jump = useCallback((hash: string) => {
    const i = rowOf.get(hash)
    if (i === undefined) {
      toast({ message: t('{hash} is older than the loaded history', { hash: shortHash(hash) }) })
      return
    }
    setSelected(hash)
    setFlash(hash)
    list.current?.scrollToIndex(i)
  }, [rowOf])

  const onJumpBranch = (branch: Branch) => {
    jump(branch.commit)
    if (!wide) setNarrowOpen(false)
  }

  const onRefresh = () => {
    refresh.mutate({ fetch: graph ? graph.remotes.length > 0 || remote : true }, {
      onError: (err) => toast({ message: t('Couldn’t refresh: {error}', { error: errorMessage(err) }) }),
    })
  }

  const onClearCache = () => {
    clear.mutate(choice.deviceId, {
      onSuccess: ({ removed, bytes }) => toast({
        message: removed > 0
          ? plural(removed, 'Removed {n} cached clone ({size}) on {device}', 'Removed {n} cached clones ({size}) on {device}', { size: formatSize(bytes), device: deviceName })
          : t('There were no cached clones on {device}', { device: deviceName }),
      }),
      onError: (err) => toast({ message: errorMessage(err) }),
    })
  }

  const toolbar = (
    <GitToolbar devices={devices} choice={choice} onChoice={onChoice} graph={graph}
      refreshing={refresh.isPending} onRefresh={onRefresh}
      branchesOpen={branchesOpen} onBranches={() => (wide ? setBranchesOpen(!storedOpen) : setNarrowOpen((o) => !o))}
      onClearCache={onClearCache} clearing={clear.isPending} />
  )

  let body: ReactNode
  if (query.isPending) {
    body = <SkeletonRows note={remote
      ? t('Reading {repo} on {device}… The first time it is fetched, this can take a minute.', { repo: repoLabel(choice), device: deviceName })
      : t('Reading {repo} on {device}…', { repo: repoLabel(choice), device: deviceName })} />
  } else if (query.isError && !graph) {
    const info = gitErrorInfo(query.error, deviceName, remote)
    body = (
      <EmptyState icon={ERROR_ICON[info.kind]} title={info.title} description={info.description}
        action={info.action === 'devices'
          ? <Link to="/settings/devices"><Button size="sm">{t('Open Devices')}</Button></Link>
          : <Button size="sm" loading={query.isFetching} icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void query.refetch()}>{t('Try again')}</Button>}>
        {info.detail && info.detail !== info.description && <p className="mt-3 max-w-sm font-mono text-[11.5px] text-subtle">{info.detail}</p>}
      </EmptyState>
    )
  } else if (graph && graph.commits.length === 0) {
    body = (
      <EmptyState icon={<GitBranch className="h-5 w-5" />}
        title={graph.head.branch ? t('No commits yet on {branch}', { branch: graph.head.branch }) : t('No commits yet')}
        description={t('Once something is committed in {repo}, its history shows up here.', { repo: repoLabel(choice) })}
        action={<Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={refresh.isPending} onClick={onRefresh}>{t('Refresh')}</Button>} />
    )
  } else if (graph) {
    const selectedCommit = selected ? commits[rowOf.get(selected) ?? -1] : undefined
    body = (
      <>
        {graph.head.detached && graph.head.commit && (
          <Notice tone="warning" icon={<AlertTriangle />}>
            {t('HEAD is detached at {hash}: not on a branch. New commits here belong to no branch until you create one.', { hash: shortHash(graph.head.commit) })}
          </Notice>
        )}
        {graph.fetchError && (
          <Notice tone="warning" icon={<CloudOff />}>
            {t('Couldn’t fetch: {error}. Showing what the computer had.', { error: graph.fetchError })}
          </Notice>
        )}
        {!remote && graph.remotes.length === 0 && (
          <Notice tone="info" icon={<Info />}>{t('This repository has no remote: Refresh reads it again, there is nothing to fetch.')}</Notice>
        )}
        <div className="relative flex min-h-0 flex-1">
          {branchesOpen && (
            <aside aria-label={t('Branches')}
              className={cn('w-60 shrink-0 border-r border-border bg-surface',
                !wide && 'absolute inset-y-0 left-0 z-20 shadow-float max-sm:w-[85%]',
                // With a commit open there is room for the branches only in a wide view.
                panel && selected && '@max-7xl/git:hidden')}>
              <BranchList branches={graph.branches} remoteRepo={remote} allBranches={allBranches} onAllBranches={setAllBranches} onJump={onJumpBranch}
                loaded={(hash) => rowOf.has(hash)} colorOf={(hash) => { const i = rowOf.get(hash); return i === undefined ? null : layout.rows[i].color }} />
            </aside>
          )}
          <div className={cn('flex min-w-0 flex-1 flex-col transition-opacity', query.isFetching && !query.isPending && 'opacity-80')}>
            <GitGraphList ref={list} commits={commits} layout={layout} pills={pills} selected={selected} flash={flash}
              headCommit={graph.head.commit ?? null} remoteRepo={remote} truncated={graph.truncated} limit={limit} maxLimit={MAX_LIMIT}
              loadingMore={query.isPlaceholderData && query.isFetching}
              label={t('Commits of {repo}', { repo: repoLabel(choice) })}
              onSelect={setSelected} onOpen={() => setPanel(true)} onClose={() => setPanel(false)}
              onLoadMore={() => setLimit((l) => LIMITS.find((x) => x > l) ?? MAX_LIMIT)} />
          </div>
          {panel && selected && (
            <aside aria-label={t('Commit details')}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setPanel(false); list.current?.focus() } }}
              className={cn('flex min-h-0 flex-col border-l border-border bg-surface',
                'absolute inset-y-0 right-0 z-30 w-full shadow-float sm:w-[23rem] @3xl/git:static @3xl/git:z-auto @3xl/git:shadow-none',
                !still && 'drawer-right')} data-state="open">
              <CommitPanel key={selected} choice={choice} hash={selected} commit={selectedCommit} remote={remote}
                known={(hash) => rowOf.has(hash)} onJump={jump} onClose={() => { setPanel(false); list.current?.focus() }} />
            </aside>
          )}
        </div>
      </>
    )
  }

  return (
    <div ref={root} className="@container/git flex h-full min-h-0 flex-col">
      {toolbar}
      {body}
    </div>
  )
}
