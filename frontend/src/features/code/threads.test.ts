import { describe, expect, it } from 'vitest'
import { groupByProject, jobDurationMs, logPath, pullRequest, threadOf, toThreads } from './threads'
import { codeJob } from './testJobs'

describe('toThreads', () => {
  it('puts follow-ups into their first job’s thread, in start order, with sums', () => {
    const first = codeJob({ id: 'a', started_at: '2026-11-23T09:00:00Z', num_turns: 10, cost_usd: 1.5, title: 'Bump the version' })
    const followUp = codeJob({ id: 'b', thread_id: 'a', started_at: '2026-11-23T11:00:00Z', num_turns: 4, cost_usd: 0.25, state: 'running' })
    const other = codeJob({ id: 'c', started_at: '2026-11-23T10:00:00Z' })
    const threads = toThreads([followUp, other, first])
    expect(threads.map((t) => t.id)).toEqual(['a', 'c'])
    const [thread] = threads
    expect(thread.jobs.map((j) => j.id)).toEqual(['a', 'b'])
    expect(thread.first.title).toBe('Bump the version')
    expect(thread.latest.id).toBe('b')
    expect(thread.costUsd).toBeCloseTo(1.75)
    expect(thread.turns).toBe(14)
    expect(threads[1]).toMatchObject({ costUsd: null, turns: null })
    expect(threadOf(threads, 'b')?.id).toBe('a')
  })

  it('reads a cost sent as a decimal string, and counts a job seen twice once', () => {
    const job = codeJob({ cost_usd: '0.5' as unknown as number })
    expect(toThreads([job, job])[0]).toMatchObject({ costUsd: 0.5, jobs: [job] })
  })
})

describe('groupByProject', () => {
  it('orders projects by their newest job, threads newest first', () => {
    const groups = groupByProject(toThreads([
      codeJob({ id: 'old-anemo', project: 'anemo', started_at: '2026-11-20T10:00:00Z' }),
      codeJob({ id: 'site', project: 'site', started_at: '2026-11-22T10:00:00Z' }),
      codeJob({ id: 'new-anemo', project: 'anemo', started_at: '2026-11-23T10:00:00Z' }),
    ]))
    expect(groups.map((g) => [g.project, g.threads.map((t) => t.id)])).toEqual([
      ['anemo', ['new-anemo', 'old-anemo']],
      ['site', ['site']],
    ])
  })
})

describe('helpers', () => {
  it('knows how long a job ran', () => {
    expect(jobDurationMs(codeJob({ duration_ms: 1234 }))).toBe(1234)
    expect(jobDurationMs(codeJob({ started_at: '2026-11-23T10:00:00Z', ended_at: '2026-11-23T10:02:00Z' }))).toBe(120_000)
    expect(jobDurationMs(codeJob({ state: 'running' }))).toBeNull()
  })

  it('says where the full log is', () => {
    expect(logPath('C:\\anemo-bridge\\jobs\\20261123-101500-ab12')).toBe('C:\\anemo-bridge\\jobs\\20261123-101500-ab12\\out.jsonl')
    expect(logPath('/home/me/jobs/x/')).toBe('/home/me/jobs/x/out.jsonl')
  })

  it('accepts only GitHub pull request addresses', () => {
    expect(pullRequest('https://github.com/essntl/anemo/pull/67')).toEqual({ url: 'https://github.com/essntl/anemo/pull/67', repo: 'essntl/anemo', number: '67' })
    expect(pullRequest('javascript:alert(1)//https://github.com/a/b/pull/1')).toBeUndefined()
    expect(pullRequest('https://github.com.evil.example/a/b/pull/1')).toBeUndefined()
    expect(pullRequest(null)).toBeUndefined()
  })
})
