/**
 * Live view of a run, built from its event stream.
 *
 * The server replays a run's events from the beginning on (re)connect, so the
 * reducer can always rebuild the partial answer — after a page refresh, a network
 * drop, or switching conversations. EventSource reconnects automatically and
 * sends Last-Event-ID, so nothing is received twice.
 */
import { useEffect, useReducer, useRef } from 'react'
import { formatCount } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { QuestionMark } from './api'
import type { Waiting } from './timing'

export const TERMINAL = ['completed', 'failed', 'cancelled']

export interface RunView {
  status: string
  text: string
  reasoning: string
  modelLabel: string | null
  notice: string | null
  error: string | null
  /** Agent runs: the user asked to pause; it takes effect at the next safe point. */
  pauseRequested: boolean
  /** Agent runs: where the agent stopped to ask the user something, and the answer. */
  questions: QuestionMark[]
  /** The time the run has waited for the user, as last reported (null: nothing new
   *  since the answer was loaded). */
  waiting: Waiting | null
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
  waiting: null,
}

export interface RunEvent {
  type: string
  data: Record<string, unknown>
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function runReducer(state: RunView, event: RunEvent | { type: 'reset' }): RunView {
  if (event.type === 'reset') return initialRunView
  const data = 'data' in event ? event.data : {}
  switch (event.type) {
    case 'run.status': {
      const error = data.error as { message?: string } | undefined
      const status = str(data.status) || state.status
      return {
        ...state,
        status,
        error: error?.message ?? state.error,
        pauseRequested: status === 'running' ? state.pauseRequested : false,
      }
    }
    case 'run.timing':
      return {
        ...state,
        waiting: { waiting_ms: Number(data.waiting_ms) || 0, waiting_since: str(data.waiting_since) || null },
      }
    case 'run.pause_requested':
      return { ...state, pauseRequested: true }
    case 'run.pause_cancelled':
      return { ...state, pauseRequested: false }
    case 'request.large':
      return {
        ...state,
        notice: t('A large request: about {tokens} tokens (tools {tools}, earlier messages {messages})', {
          tokens: formatCount(Number(data.tokens) || 0),
          tools: formatCount(Number(data.tools) || 0),
          messages: formatCount(Number(data.messages) || 0),
        }),
      }
    case 'context.compacted':
      return { ...state, notice: t('Older steps were summarized to keep the context small') }
    case 'message.delta':
      return { ...state, text: state.text + str(data.text) }
    case 'message.question':
      return {
        ...state,
        questions: [
          ...state.questions,
          { at: Number(data.at) || 0, question: str(data.question), answer: str(data.answer) || null },
        ],
      }
    case 'reasoning.delta':
      return { ...state, reasoning: state.reasoning + str(data.text) }
    case 'run.model':
      return { ...state, modelLabel: str(data.label) || state.modelLabel }
    case 'run.fallback':
      // The reason is the provider's own error, e.g. a usage limit: say it, don't hide it.
      return { ...state, notice: t('{from} was unavailable{reason}, switched to {to}', { from: str(data.from), reason: fallbackReason(data.reason), to: str(data.to) }) }
    case 'run.restarted':
      // The worker restarted the run from scratch: drop what was streamed so far.
      return { ...state, text: '', reasoning: '', notice: t('Resumed after an interruption') }
    default:
      return state
  }
}

const EVENT_TYPES = [
  'run.status',
  'message.delta',
  'message.question', // the agent's question was answered: shown between the texts
  'reasoning.delta',
  'run.model',
  'run.fallback',
  'run.restarted',
  'run.timing', // the time spent waiting for the user changed (the timer stops or goes on)
  // Agent runs: the timeline itself is loaded from the API when these arrive.
  'tool.started',
  'tool.completed',
  'tool.denied',
  'approval.requested',
  'approval.resolved',
  'plan.updated',
  'tool.progress', // live shell output
  'run.pause_requested',
  'run.pause_cancelled',
  'context.compacted',
  'request.large', // the first request was large: what made it so
  'memory.saved', // a memory tool saved something (shown as a notice with Undo)
]

/** Subscribes to a run's events while `runId` is set. Calls `onFinished` once at the end. */
export function useRunStream(
  runId: string | null,
  onFinished?: (view: RunView) => void,
  onEvent?: (event: RunEvent) => void,
): RunView {
  const [view, dispatch] = useReducer(runReducer, initialRunView)
  // Kept in a ref so a new callback on re-render does not restart the stream.
  const finished = useRef(onFinished)
  const eventHook = useRef(onEvent)
  useEffect(() => {
    finished.current = onFinished
    eventHook.current = onEvent
  })

  useEffect(() => {
    dispatch({ type: 'reset' })
    if (!runId) return
    let state = initialRunView
    const source = new EventSource(`/api/runs/${runId}/events`)
    const handle = (type: string) => (e: MessageEvent<string>) => {
      const event: RunEvent = { type, data: JSON.parse(e.data) as Record<string, unknown> }
      state = runReducer(state, event)
      dispatch(event)
      eventHook.current?.(event)
      if (type === 'run.status' && TERMINAL.includes(state.status)) {
        source.close()
        finished.current?.(state)
      }
    }
    for (const type of EVENT_TYPES) source.addEventListener(type, handle(type) as EventListener)
    return () => source.close()
  }, [runId])

  return view
}

/** " (the reason)" for the fallback notice, shortened; nothing when there is none. */
function fallbackReason(reason: unknown): string {
  const text = typeof reason === 'string' ? reason.trim() : ''
  if (!text || text === 'unavailable') return ''
  return ` (${text.length > 160 ? `${text.slice(0, 157)}…` : text})`
}
