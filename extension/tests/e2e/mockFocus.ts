/** The focus timer for the mock Anemo: one shared, versioned state; focus.timer events; sessions. */
import { send, type MockAnemo } from './mockAnemo'
import type { MockEvents } from './mockEvents'

export interface TimerWire {
  phase: string
  status: string
  phase_started_at: number | null
  started_at: number | null
  paused_at: number | null
  accumulated: number
  duration: number
  round: number
  task_id: string | null
  session_id: string
}

export function addFocus(anemo: MockAnemo, events: MockEvents) {
  const timer = { state: null as TimerWire | null, version: 0, updated_by: '' }
  const sessions: Record<string, unknown>[] = []
  const phaseEnded: Record<string, unknown>[] = []
  const puts: { base_version: number; source: string; status: string }[] = []
  const out = () => ({ state: timer.state, version: timer.version, updated_by: timer.updated_by, updated_at: timer.state ? new Date().toISOString() : null })

  /** A change made in Anemo (a tab, another device): stored and announced. */
  const changeElsewhere = (state: TimerWire) => {
    timer.state = state
    timer.version += 1
    timer.updated_by = 'tab'
    events.publish('focus.timer', out())
  }

  anemo.routes.set('GET /api/settings', (_r, _b, res) =>
    send(res, 200, {
      appearance: { accent: '#3478f6', mode: 'system', density: 'comfortable' },
      general: { default_chat_mode: 'chat', timezone: 'UTC' },
      models: { chat: 'm-echo' },
      focus: { focus_minutes: 25, short_break_minutes: 5, long_break_minutes: 15, rounds_before_long_break: 4, auto_start_breaks: true, auto_start_focus: false },
    }),
  )
  anemo.routes.set('GET /api/focus/timer', (_r, _b, res) => send(res, 200, out()))
  anemo.routes.set('PUT /api/focus/timer', (_r, body, res) => {
    const b = body as { state: TimerWire; base_version: number; source: string }
    puts.push({ base_version: b.base_version, source: b.source, status: b.state.status })
    if (b.base_version !== timer.version) return send(res, 409, { error: { code: 'timer_conflict', message: 'The timer was changed elsewhere first', details: { current: out() } } })
    timer.state = b.state
    timer.version += 1
    timer.updated_by = b.source
    send(res, 200, out())
    events.publish('focus.timer', out())
  })
  anemo.routes.set('POST /api/focus/sessions', (_r, body, res) => {
    sessions.push(body as Record<string, unknown>)
    send(res, 201, { id: `fs-${sessions.length}`, ...(body as object) })
  })
  anemo.routes.set('POST /api/focus/phase-ended', (_r, body, res) => {
    phaseEnded.push(body as Record<string, unknown>)
    res.writeHead(204).end()
  })
  anemo.routes.set('GET /api/tasks', (_r, _b, res) =>
    send(res, 200, [{ id: 'task-1', title: 'Write the introduction', status: 'todo', priority: 'none', tags: [], checklist: [], blocked_by: [] }]),
  )
  return { timer, sessions, phaseEnded, puts, changeElsewhere }
}
