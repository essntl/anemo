/**
 * What the Git view remembers on this device: the repository picked last (shown when no
 * job is open), whether the graph shows every branch or only what HEAD can reach, and
 * whether the branch list is open.
 */
import { create } from 'zustand'
import type { GitRepoChoice } from './gitApi'

const REPO_KEY = 'anemo.code.gitRepo'
const ALL_KEY = 'anemo.code.gitAll'
const BRANCHES_KEY = 'anemo.code.gitBranches'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // no storage: just not remembered
  }
}

/** The stored choice, if it is one: `{deviceId, project}` or `{deviceId, repo}`. */
export function storedRepo(): GitRepoChoice | null {
  try {
    const value: unknown = JSON.parse(read(REPO_KEY) ?? 'null')
    if (!value || typeof value !== 'object') return null
    const { deviceId, project, repo } = value as Record<string, unknown>
    if (typeof deviceId !== 'string' || !deviceId) return null
    if (typeof repo === 'string' && repo) return { deviceId, repo }
    if (typeof project === 'string' && project) return { deviceId, project }
    return null
  } catch {
    return null
  }
}

interface GitViewState {
  repo: GitRepoChoice | null
  /** Every branch (`all: true`), or only what HEAD can reach. */
  allBranches: boolean
  branchesOpen: boolean
  setRepo: (repo: GitRepoChoice) => void
  setAllBranches: (all: boolean) => void
  setBranchesOpen: (open: boolean) => void
}

export const useGitViewStore = create<GitViewState>((set) => ({
  repo: storedRepo(),
  allBranches: read(ALL_KEY) !== 'false',
  branchesOpen: read(BRANCHES_KEY) !== 'false',
  setRepo: (repo) => {
    write(REPO_KEY, JSON.stringify(repo.repo !== undefined ? { deviceId: repo.deviceId, repo: repo.repo } : { deviceId: repo.deviceId, project: repo.project }))
    set({ repo })
  },
  setAllBranches: (allBranches) => {
    write(ALL_KEY, String(allBranches))
    set({ allBranches })
  },
  setBranchesOpen: (branchesOpen) => {
    write(BRANCHES_KEY, String(branchesOpen))
    set({ branchesOpen })
  },
}))
