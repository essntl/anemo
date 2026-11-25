/**
 * The Git view's server state: a repository's graph and one commit, read on a computer
 * (docs/device-contracts.md §7.5, §7.6), and clearing the computer's cache of clones.
 *
 * Not under `codeKey`: every `code.job` notice refreshes that, and each read here runs git
 * on the computer. The graph is read again only when asked (Refresh), when a job of its
 * project changes state (GitView.tsx) or when its options change; never on window focus.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

export type GitGraph = Schemas['GitGraph']
export type GitCommit = Schemas['GitGraphCommit']
export type GitCommitDetail = Schemas['GitCommitDetail']
export type GitBranch = Schemas['GitBranch']

/** Which repository on which computer: a local checkout (`project`) or a GitHub repository not cloned there (`repo`). */
export type GitRepoChoice = { deviceId: string; project: string; repo?: undefined } | { deviceId: string; repo: string; project?: undefined }

/** The body's `project` or `repo`. */
export const whereOf = (choice: GitRepoChoice): { project: string } | { repo: string } =>
  choice.repo !== undefined ? { repo: choice.repo } : { project: choice.project }

/** The repository's name as shown: the folder, or owner/name. */
export const repoLabel = (choice: GitRepoChoice): string => choice.repo ?? choice.project

export const gitKey = ['code-git'] as const
const repoKey = (choice: GitRepoChoice) => [...gitKey, choice.deviceId, choice.repo !== undefined ? `repo:${choice.repo}` : `project:${choice.project}`] as const
export const gitGraphKey = (choice: GitRepoChoice, limit: number, all: boolean) => [...repoKey(choice), 'graph', limit, all] as const
export const gitCommitKey = (choice: GitRepoChoice, hash: string) => [...repoKey(choice), 'commit', hash] as const
/** Every graph of a repository (whatever its limit and branches). */
export const gitGraphsKey = (choice: GitRepoChoice) => [...repoKey(choice), 'graph'] as const

export interface GraphOptions {
  limit: number
  all: boolean
}

async function readGraph(choice: GitRepoChoice, { limit, all }: GraphOptions, fetch: boolean): Promise<GitGraph> {
  return unwrap(await api.POST('/api/code/devices/{device_id}/git/graph', {
    params: { path: { device_id: choice.deviceId } },
    body: { ...whereOf(choice), limit, all, fetch },
  }))
}

/** A repository's graph (without fetching first). */
export function useGitGraph(choice: GitRepoChoice | null, options: GraphOptions) {
  return useQuery({
    queryKey: choice ? gitGraphKey(choice, options.limit, options.all) : [...gitKey, 'none'],
    enabled: Boolean(choice),
    queryFn: () => readGraph(choice!, options, false),
    // More commits or other branches of the same repository: the rows stay while they load.
    placeholderData: (previous, query) => (previous && query && sameRepo(query.queryKey, choice) ? keepPreviousData(previous) : undefined),
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

const sameRepo = (key: readonly unknown[], choice: GitRepoChoice | null): boolean =>
  Boolean(choice) && key[1] === choice!.deviceId && key[2] === repoKey(choice!)[2]

/** Refresh: `git fetch --prune` on the computer, then the graph again (it replaces the one shown). */
export function useFetchGraph(choice: GitRepoChoice | null, options: GraphOptions) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ fetch }: { fetch: boolean }) => readGraph(choice!, options, fetch),
    onSuccess: (graph) => {
      if (choice) qc.setQueryData(gitGraphKey(choice, options.limit, options.all), graph)
    },
  })
}

/** One commit's message and changed files. */
export function useGitCommit(choice: GitRepoChoice | null, hash: string | null) {
  return useQuery({
    queryKey: choice && hash ? gitCommitKey(choice, hash) : [...gitKey, 'none', 'commit'],
    enabled: Boolean(choice && hash),
    queryFn: async () => unwrap(await api.POST('/api/code/devices/{device_id}/git/commit', {
      params: { path: { device_id: choice!.deviceId } },
      body: { ...whereOf(choice!), hash: hash! },
    })),
    // A commit doesn't change.
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  })
}

/** Removes the clones a computer keeps of repositories that aren't cloned there. */
export function useClearGitCache() {
  return useMutation({
    mutationFn: async (deviceId: string) =>
      unwrap(await api.POST('/api/code/devices/{device_id}/git/cache/clear', { params: { path: { device_id: deviceId } } })),
  })
}
