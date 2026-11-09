/**
 * The live state of a run, built from its events (the same reducer as Anemo's
 * frontend/src/features/chat/runStream.ts, so both show the same thing). The server
 * replays a run's events from the start on a fresh connection, so the partial answer is
 * always rebuilt in full.
 */

export const TERMINAL = ['completed', 'failed', 'cancelled']

export interface QuestionMark {
  at: number
  question: string
  answer: string | null
}

export interface RunView {
  status: string
  text: string
  reasoning: string
  modelLabel: string | null
  notice: string | null
  error: string | null
  pauseRequested: boolean
  questions: QuestionMark[]
  /** Bumped when the agent's timeline changed (tool calls, approvals, plan). */
  timelineVersion: number
}

export const initialRunView: RunView = {
  status: 'queued',
  text: '',
  reasoning: '',
  modelLabel: null,
  notice: null,
  error: null,
  pauseRequested: false,
  questions: [],
  timelineVersion: 0,
}

export interface RunEvent {
  type: string
  data: Record<string, unknown>
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const TIMELINE_EVENTS = new Set(['tool.started', 'tool.completed', 'tool.denied', 'approval.requested', 'approval.resolved', 'plan.updated'])

export function runReducer(state: RunView, event: RunEvent | { type: 'reset' }): RunView {
  if (event.type === 'reset') return initialRunView
  const data = 'data' in event ? event.data : {}
  if (TIMELINE_EVENTS.has(event.type)) return { ...state, timelineVersion: state.timelineVersion + 1 }
  switch (event.type) {
    case 'run.status': {
      const error = data.error as { message?: string } | string | undefined
      const status = str(data.status) || state.status
      const message = typeof error === 'string' ? error : error?.message
      return { ...state, status, error: message ?? state.error, pauseRequested: status === 'running' ? state.pauseRequested : false }
    }
    case 'run.pause_requested':
      return { ...state, pauseRequested: true }
    case 'run.pause_cancelled':
      return { ...state, pauseRequested: false }
    case 'context.compacted':
      return { ...state, notice: 'Older steps were summarized to keep the context small' }
    case 'message.delta':
      return { ...state, text: state.text + str(data.text) }
    case 'message.question':
      return {
        ...state,
        questions: [...state.questions, { at: Number(data.at) || 0, question: str(data.question), answer: str(data.answer) || null }],
      }
    case 'reasoning.delta':
      return { ...state, reasoning: state.reasoning + str(data.text) }
    case 'run.model':
      return { ...state, modelLabel: str(data.label) || state.modelLabel }
    case 'run.fallback':
      return { ...state, notice: `${str(data.from)} was unavailable, switched to ${str(data.to)}` }
    case 'run.restarted':
      return { ...state, text: '', reasoning: '', notice: 'Resumed after an interruption' }
    default:
      return state
  }
}
