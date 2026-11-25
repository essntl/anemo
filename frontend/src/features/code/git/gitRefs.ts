/**
 * The refs of a commit as pills (the Code page's Git view): HEAD, the local branches, the
 * remote-tracking ones (muted) and the tags, in that order. A local branch whose upstream
 * points at the same commit is one pill with a "synced" mark instead of two; a branch
 * carries how far it is ahead of and behind its upstream, and its open pull request.
 * Pure.
 */
import type { Schemas } from '@/api/client'

type Branch = Schemas['GitBranch']
export type PullRequest = Schemas['GitPullRequest']

export type RefPill =
  | { kind: 'head'; detached: boolean }
  | {
      kind: 'branch'
      name: string
      /** HEAD is on it. */
      current: boolean
      /** Its upstream ("origin/main"), when it has one. */
      upstream: string | null
      /** The upstream points at this same commit: shown in this pill, not one of its own. */
      synced: boolean
      ahead: number
      behind: number
      pullRequest: PullRequest | null
    }
  | { kind: 'remote'; name: string; pullRequest: PullRequest | null }
  | { kind: 'tag'; name: string }

/** What the pills of every commit are worked out from: the graph's branches and remotes. */
export interface RefContext {
  branches: readonly Branch[]
  /** The remotes' names ("origin"), to tell "origin/x" from a local branch named so. */
  remotes: readonly string[]
}

/** Prepared once per graph: the branches by name. */
export interface RefIndex {
  byName: Map<string, Branch>
  remotes: readonly string[]
}

export function refIndex({ branches, remotes }: RefContext): RefIndex {
  return { byName: new Map(branches.map((b) => [b.name, b])), remotes }
}

const isRemoteName = (index: RefIndex, name: string): boolean =>
  index.byName.get(name)?.remote ?? index.remotes.some((r) => name.startsWith(`${r}/`))

/**
 * The pills of one commit, from its refs as git decorates them ("HEAD", "main",
 * "origin/main", "tag: v1.0"; "HEAD -> main" is read too). `detached`: HEAD is on no
 * branch. A remote's own HEAD ("origin/HEAD") is left out: it only repeats the default branch.
 */
export function refPills(refs: readonly string[], index: RefIndex, detached = false): RefPill[] {
  let head = false
  const tags: string[] = []
  const names: string[] = []
  for (const raw of refs) {
    const ref = raw.trim()
    if (!ref) continue
    if (ref.startsWith('tag: ')) tags.push(ref.slice(5).trim())
    else if (ref === 'HEAD') head = true
    else if (ref.startsWith('HEAD -> ')) {
      head = true
      names.push(ref.slice(8).trim())
    } else names.push(ref)
  }

  const remoteHere = new Set(names.filter((n) => isRemoteName(index, n)))
  const shownIn = new Set<string>() // remote names folded into a local branch's pill
  const locals: RefPill[] = []
  for (const name of names) {
    if (remoteHere.has(name)) continue
    const b = index.byName.get(name)
    const upstream = b?.upstream ?? null
    const synced = Boolean(upstream && remoteHere.has(upstream))
    if (synced && upstream) shownIn.add(upstream)
    locals.push({
      kind: 'branch', name, current: b?.current ?? false, upstream, synced,
      ahead: b?.ahead ?? 0, behind: b?.behind ?? 0,
      // A synced pill stands for its upstream too: the upstream's pull request shows on it.
      pullRequest: b?.pullRequest ?? (synced && upstream ? index.byName.get(upstream)?.pullRequest ?? null : null),
    })
  }
  // The current branch first, then by name.
  locals.sort((a, b) => Number(b.kind === 'branch' && b.current) - Number(a.kind === 'branch' && a.current) || nameOf(a).localeCompare(nameOf(b)))

  const remotes: RefPill[] = [...remoteHere]
    .filter((name) => !shownIn.has(name) && !name.endsWith('/HEAD'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ kind: 'remote', name, pullRequest: index.byName.get(name)?.pullRequest ?? null }))

  return [
    ...(head ? [{ kind: 'head', detached } as const] : []),
    ...locals,
    ...remotes,
    ...tags.sort((a, b) => a.localeCompare(b)).map((name) => ({ kind: 'tag', name }) as const),
  ]
}

const nameOf = (pill: RefPill): string => (pill.kind === 'head' ? '' : pill.name)

