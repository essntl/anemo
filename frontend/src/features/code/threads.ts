/**
 * Claude Code jobs grouped as the Code page shows them (docs/specs/code-sessions.md
 * §7.2): a follow-up (`resume_session`) belongs to its first job's thread (the server
 * gives every job its `thread_id`), the list shows one row per thread, and the rows
 * are grouped by project. Pure.
 */
import type { Schemas } from '@/api/client'
import { num } from './timeline'

export type CodeJob = Schemas['CodeJobOut']
export type CodeJobState = CodeJob['state']

export const JOB_STATES: CodeJobState[] = ['running', 'done', 'failed', 'cancelled', 'exited_without_result']

export interface CodeThread {
  id: string
  /** In start order. */
  jobs: CodeJob[]
  first: CodeJob
  latest: CodeJob
  /** API-equivalent cost of every job of the thread; null when no job reported one. */
  costUsd: number | null
  /** Turns of every job; null when no job reported them. */
  turns: number | null
}

export interface ProjectGroup {
  project: string
  /** Newest first. */
  threads: CodeThread[]
}

const time = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0)

/** Oldest first; jobs started in the same second by their folder name. */
const byStart = (a: CodeJob, b: CodeJob) => time(a.started_at) - time(b.started_at) || a.job_key.localeCompare(b.job_key)

/** A sum of numbers that may be unknown: null when all of them are. */
function sum(values: (number | undefined)[]): number | null {
  const known = values.filter((v): v is number => v !== undefined)
  return known.length ? known.reduce((a, b) => a + b, 0) : null
}

/** The threads of these jobs, the one with the newest job first. */
export function toThreads(jobs: readonly CodeJob[]): CodeThread[] {
  const byThread = new Map<string, CodeJob[]>()
  const seen = new Set<string>()
  for (const job of jobs) {
    if (seen.has(job.id)) continue // a job on two pages of the list
    seen.add(job.id)
    const id = job.thread_id || job.id
    const list = byThread.get(id)
    if (list) list.push(job)
    else byThread.set(id, [job])
  }
  const threads = [...byThread.entries()].map(([id, list]): CodeThread => {
    const sorted = [...list].sort(byStart)
    return {
      id,
      jobs: sorted,
      first: sorted[0],
      latest: sorted[sorted.length - 1],
      costUsd: sum(sorted.map((j) => num(j.cost_usd))),
      turns: sum(sorted.map((j) => num(j.num_turns))),
    }
  })
  return threads.sort((a, b) => byStart(b.latest, a.latest))
}

/** Threads by project (the latest job's), projects ordered by their newest job. */
export function groupByProject(threads: readonly CodeThread[]): ProjectGroup[] {
  const groups = new Map<string, CodeThread[]>()
  for (const thread of [...threads].sort((a, b) => byStart(b.latest, a.latest))) {
    const project = thread.latest.project
    const list = groups.get(project)
    if (list) list.push(thread)
    else groups.set(project, [thread])
  }
  // A Map keeps the order of insertion: the project of the newest thread comes first.
  return [...groups.entries()].map(([project, list]) => ({ project, threads: list }))
}

/** How long a job ran: as Claude Code reported it, else from its start to its end. Null while running. */
export function jobDurationMs(job: CodeJob): number | null {
  const reported = num(job.duration_ms)
  if (reported !== undefined) return reported
  if (!job.ended_at) return null
  const ms = time(job.ended_at) - time(job.started_at)
  return ms >= 0 ? ms : null
}

/** The thread a job belongs to, from a list of threads. */
export const threadOf = (threads: readonly CodeThread[], jobId: string): CodeThread | undefined =>
  threads.find((t) => t.jobs.some((j) => j.id === jobId))

/** Where the full log of a job is on its computer. */
export function logPath(jobDir: string): string {
  const sep = jobDir.includes('\\') || !jobDir.includes('/') ? '\\' : '/'
  return `${jobDir.replace(/[\\/]+$/, '')}${sep}out.jsonl`
}

/** A GitHub pull request address, or undefined when it isn't one (the text came from a job). */
export function pullRequest(url: string | null | undefined): { url: string; repo: string; number: string } | undefined {
  const m = url?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/)
  return m ? { url: m[0], repo: m[1], number: m[2] } : undefined
}
