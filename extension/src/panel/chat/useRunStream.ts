import { useEffect, useReducer, useRef } from 'react'
import { ApiError, authHeaders, classifyResponse, fromErrorBody } from '@/shared/api'
import { log } from '@/shared/env'
import { initialRunView, runReducer, TERMINAL, type RunEvent, type RunView } from '@/shared/runReducer'
import { readStream } from '@/shared/sse'
import { markTokenLost } from '../state/connection'
import { useSession } from '../state/useSession'

/**
 * Follows a run's live events while `runId` is set, and calls `onFinished` once at the end.
 * The stream lives in the panel (not the worker); closing the panel just stops watching,
 * the run goes on in Anemo and reopening picks it up again.
 */
export function useRunStream(runId: string | null, onFinished?: (view: RunView) => void): RunView {
  const { connection } = useSession()
  const [view, dispatch] = useReducer(runReducer, initialRunView)
  const finished = useRef(onFinished)
  useEffect(() => {
    finished.current = onFinished
  })

  useEffect(() => {
    dispatch({ type: 'reset' })
    if (!runId) return
    const controller = new AbortController()
    let state = initialRunView
    void readStream({
      url: `${connection.serverUrl}/api/runs/${runId}/events`,
      headers: authHeaders(connection.token),
      signal: controller.signal,
      check: async (res) => {
        const problem = await classifyResponse(res)
        if (problem) return problem
        if (!res.ok) {
          const err = fromErrorBody(res.status, await res.json().catch(() => undefined))
          if (err.kind === 'unauthorized') void markTokenLost()
          return err
        }
        return null
      },
      onEvent: (e) => {
        let data: Record<string, unknown> = {}
        try {
          data = JSON.parse(e.data) as Record<string, unknown>
        } catch {
          return
        }
        const event: RunEvent = { type: e.type, data }
        state = runReducer(state, event)
        dispatch(event)
      },
      isEnd: (e) => e.type === 'run.status' && TERMINAL.includes(state.status),
      onError: (err, attempt) => {
        log.debug('run stream retry', { attempt })
        // A missing run or a lost token won't come back by retrying.
        return !(err instanceof ApiError && (err.kind === 'unauthorized' || err.status === 404))
      },
    }).then(() => {
      if (!controller.signal.aborted && TERMINAL.includes(state.status)) finished.current?.(state)
    })
    return () => controller.abort()
  }, [runId, connection.serverUrl, connection.token])

  return view
}
