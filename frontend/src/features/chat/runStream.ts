/**
 * Live view of a run, built from its event stream.
 *
 * The server replays a run's events from the beginning on (re)connect, so the
 * reducer can always rebuild the partial answer — after a page refresh, a network
 * drop, or switching conversations. EventSource reconnects automatically and
 * sends Last-Event-ID, so nothing is received twice.
 */
import { useEffect, useReducer, useRef } from 'react'

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
}

export const initialRunView: RunView = {
  status: 'queued',
  text: '',
  reasoning: '',
  modelLabel: null,
  notice: null,
  error: null,
  pauseRequested: false,
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
    case 'run.pause_requested':
      return { ...state, pauseRequested: true }
    case 'run.pause_cancelled':
      return { ...state, pauseRequested: false }
    case 'context.compacted':
      return { ...state, notice: 'Older steps were summarized to keep the context small' }
    case 'message.delta':
      return { ...state, text: state.text + str(data.text) }
    case 'reasoning.delta':
      return { ...state, reasoning: state.reasoning + str(data.text) }
    case 'run.model':
      return { ...state, modelLabel: str(data.label) || state.modelLabel }
    case 'run.fallback':
      return { ...state, notice: `${str(data.from)} was unavailable, switched to ${str(data.to)}` }
    case 'run.restarted':
      // The worker restarted the run from scratch: drop what was streamed so far.
      return { ...state, text: '', reasoning: '', notice: 'Resumed after an interruption' }
    default:
      return state
  }
}

const EVENT_TYPES = [
  'run.status',
  'message.delta',
  'reasoning.delta',
  'run.model',
  'run.fallback',
  'run.restarted',
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
