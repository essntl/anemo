/** Jobs for the Code page's tests. */
import type { CodeJob } from './threads'

let n = 0
/** A finished job of the project "anemo" on an online computer, with `more` on top. */
export function codeJob(more: Partial<CodeJob> = {}): CodeJob {
  n += 1
  const id = more.id ?? `job-${n}`
  return {
    id, job_key: `20261123-1015${String(n).padStart(2, '0')}-ab1${n % 10}`,
    device: { id: 'dev-1', name: 'Desk PC', online: true, last_seen_at: '2026-11-23T10:00:00Z', share: true, start: true, cancel: true },
    project: 'anemo', dir: 'C:\\dev\\anemo', job_dir: `C:\\anemo-bridge\\jobs\\${id}`, title: `Job ${n}`, prompt: `Prompt ${n}`,
    state: 'done', started_at: '2026-11-23T10:00:00Z', ended_at: null, last_event_at: null, session_id: null, resume_session: null,
    thread_id: id, model: null, branch: null, pr_url: null, todos: [], num_turns: null, duration_ms: null, cost_usd: null,
    result_text: null, result_subtype: null, is_error: false, stderr_tail: null, last_seq: 0, event_count: 0, truncated: false,
    conversation_id: null, run_id: null, conversation_title: null, images: [],
    ...more,
  }
}
