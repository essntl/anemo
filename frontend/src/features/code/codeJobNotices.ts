/**
 * The app-wide `code.job` notices (features/chat/useAppEvents.ts hands each one here), for
 * what follows the jobs of one project without a stream of its own: the plugin tabs of the
 * Code page get `code.job` from them (plugin contract §3, `code.panel`).
 */

/** A notice as the server sends it (only the fields read here). */
export interface CodeJobNotice {
  job_id?: string
  device_id?: string
  project?: string
  state?: string
}

/** The project a plugin tab is about: the computer (by id and by name) and the folder. */
export interface CodeSelection {
  deviceId: string
  device: string
  project: string
  jobId: string | null
}

/** What a `code.panel` frame gets: states only, never a job's text. */
export interface CodeJobEvent {
  device: string
  project: string
  jobId: string
  state: string
}

type Listener = (notice: CodeJobNotice) => void

const listeners = new Set<Listener>()

/** A notice came in: tell whoever follows them. */
export function noticeCodeJob(notice: CodeJobNotice): void {
  listeners.forEach((listener) => listener(notice))
}

/** Follow the notices. Returns a function that stops. */
export function onCodeJobNotice(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Follow the jobs of the selected project: `emit` hears of each job's state once per
 * change (the server repeats a running job's notice every few seconds). `selection()` is
 * read at every notice, so a tab that stays while another job is opened follows the new
 * project. Returns a function that stops.
 */
export function watchProjectJobs(selection: () => CodeSelection | null, emit: (event: CodeJobEvent) => void): () => void {
  const last = new Map<string, string>()
  return onCodeJobNotice((notice) => {
    const s = selection()
    const { job_id: jobId, state } = notice
    if (!s || !jobId || !state || notice.device_id !== s.deviceId || notice.project !== s.project) return
    if (last.get(jobId) === state) return
    last.set(jobId, state)
    emit({ device: s.device, project: s.project, jobId, state })
  })
}
