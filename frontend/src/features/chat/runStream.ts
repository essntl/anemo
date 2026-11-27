/**
 * Live view of a run, built from its event stream.
 *
 * The server replays a run's events from the beginning on (re)connect, so the
 * reducer can always rebuild the partial answer — after a page refresh, a network
 * drop, or switching conversations. EventSource reconnects automatically and
 * sends Last-Event-ID, so nothing is received twice.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
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
  'memory.saved', // a memory tool saved something (shown as a notice with Undo)
]

/**
 * A run's live view kept outside React state: a component re-renders only for the part
 * it selects (useRunSelector). Text deltas arrive ~50 times a second; when the whole
 * chat page re-rendered for each, every earlier message did too.
 */
export interface RunStore {
  get: () => RunView
  subscribe: (listener: () => void) => () => void
}

function createRunStore(): RunStore & { set: (view: RunView) => void } {
  let view = initialRunView
  const listeners = new Set<() => void>()
  return {
    get: () => view,
    set: (next) => {
      if (next === view) return
      view = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Subscribes to a run's events while `runId` is set. Calls `onFinished` once at the end.
 * The view is in the returned store; the component calling this does not re-render. */
export function useRunStore(
  runId: string | null,
  onFinished?: (view: RunView) => void,
  onEvent?: (event: RunEvent) => void,
): RunStore {
  const [store] = useState(createRunStore)
  // Kept in a ref so a new callback on re-render does not restart the stream.
  const finished = useRef(onFinished)
  const eventHook = useRef(onEvent)
  useEffect(() => {
    finished.current = onFinished
    eventHook.current = onEvent
  })

  useEffect(() => {
    store.set(initialRunView)
    if (!runId) return
    const source = new EventSource(`/api/runs/${runId}/events`)
    const handle = (type: string) => (e: MessageEvent<string>) => {
      const event: RunEvent = { type, data: JSON.parse(e.data) as Record<string, unknown> }
      store.set(runReducer(store.get(), event))
      eventHook.current?.(event)
      if (type === 'run.status' && TERMINAL.includes(store.get().status)) {
        source.close()
        finished.current?.(store.get())
      }
    }
    for (const type of EVENT_TYPES) source.addEventListener(type, handle(type) as EventListener)
    return () => source.close()
  }, [runId, store])

  return store
}

/**
 * The part of a run's view a component shows; it re-renders when that part changes
 * (`equal` decides; shallowEqual for an object). `select` must be a module-level
 * function: the value is kept per view, not per selector.
 */
export function useRunSelector<T>(store: RunStore, select: (view: RunView) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const last = useRef<{ view: RunView; value: T } | null>(null)
  const snapshot = () => {
    const view = store.get()
    const before = last.current
    if (before?.view === view) return before.value
    const value = select(view)
    last.current = { view, value: before && equal(before.value, value) ? before.value : value }
    return last.current.value
  }
  return useSyncExternalStore(store.subscribe, snapshot)
}

/** Each field the same (Object.is): for selectors that return an object. */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[]
  return keys.length === Object.keys(b).length && keys.every((k) => Object.is(a[k], b[k]))
}

const wholeView = (view: RunView) => view

/** The whole live view, re-rendering on every event (fine for small views). */
export function useRunStream(
  runId: string | null,
  onFinished?: (view: RunView) => void,
  onEvent?: (event: RunEvent) => void,
): RunView {
  return useRunSelector(useRunStore(runId, onFinished, onEvent), wholeView)
}

/** " (the reason)" for the fallback notice, shortened; nothing when there is none. */
function fallbackReason(reason: unknown): string {
  const text = typeof reason === 'string' ? reason.trim() : ''
  if (!text || text === 'unavailable') return ''
  return ` (${text.length > 160 ? `${text.slice(0, 157)}…` : text})`
}
