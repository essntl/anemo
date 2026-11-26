import { describe, expect, it, vi } from 'vitest'
import { type CodeSelection, noticeCodeJob, watchProjectJobs } from './codeJobNotices'

/* What a plugin's Code tab hears of the jobs (plugin contract §3, `code.panel`). */

const anemo: CodeSelection = { deviceId: 'dev-1', device: 'Desk PC', project: 'anemo', jobId: 'job-1' }

describe('watchProjectJobs', () => {
  it('passes on the jobs of the selected project, once per state', () => {
    const emit = vi.fn()
    const stop = watchProjectJobs(() => anemo, emit)

    noticeCodeJob({ job_id: 'job-2', device_id: 'dev-1', project: 'anemo', state: 'running' })
    noticeCodeJob({ job_id: 'job-2', device_id: 'dev-1', project: 'anemo', state: 'running' }) // the periodic repeat
    noticeCodeJob({ job_id: 'job-2', device_id: 'dev-1', project: 'anemo', state: 'done' })
    stop()
    noticeCodeJob({ job_id: 'job-3', device_id: 'dev-1', project: 'anemo', state: 'running' })

    expect(emit.mock.calls).toEqual([
      [{ device: 'Desk PC', project: 'anemo', jobId: 'job-2', state: 'running' }],
      [{ device: 'Desk PC', project: 'anemo', jobId: 'job-2', state: 'done' }],
    ])
  })

  it('leaves out other projects, other computers and notices without a job', () => {
    const emit = vi.fn()
    const stop = watchProjectJobs(() => anemo, emit)

    noticeCodeJob({ job_id: 'job-2', device_id: 'dev-1', project: 'notes', state: 'running' })
    noticeCodeJob({ job_id: 'job-2', device_id: 'dev-2', project: 'anemo', state: 'running' })
    noticeCodeJob({ device_id: 'dev-1' }) // a computer went offline
    stop()

    expect(emit).not.toHaveBeenCalled()
  })

  it('follows the selection as it changes, and nothing without one', () => {
    const emit = vi.fn()
    let selected: CodeSelection | null = null
    const stop = watchProjectJobs(() => selected, emit)

    noticeCodeJob({ job_id: 'job-2', device_id: 'dev-1', project: 'notes', state: 'running' })
    selected = { ...anemo, project: 'notes' }
    noticeCodeJob({ job_id: 'job-2', device_id: 'dev-1', project: 'notes', state: 'failed' })
    stop()

    expect(emit.mock.calls).toEqual([[{ device: 'Desk PC', project: 'notes', jobId: 'job-2', state: 'failed' }]])
  })
})
