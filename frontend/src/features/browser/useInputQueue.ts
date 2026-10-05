import { useEffect, useRef } from 'react'
import { type BrowserInput, useBrowserInput } from './api'
import { mergeInputs } from './input'

/** Wait this long for more keystrokes or wheel steps before sending what was collected. */
const COLLECT_MS = 120

/**
 * Sends what the user does to the browser, in order and one at a time. Fast
 * typing and scrolling are collected for a moment and sent together, so the
 * browser is not asked for a new picture after every single key.
 *
 *   const queue = useInputQueue(conversationId, live)
 *   queue.push({ kind: 'click', x, y })
 *
 * `live`: the picture is streamed, so the browser need not send one back (or wait for
 * the page to settle first): each input is answered at once.
 */
export function useInputQueue(conversationId: string, live = false) {
  const send = useBrowserInput(conversationId)
  const waiting = useRef<BrowserInput[]>([])
  const sending = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const picture = useRef(!live)
  useEffect(() => {
    picture.current = !live
  }, [live])

  const flush = async () => {
    if (sending.current) return // the running flush picks up what was added meanwhile
    sending.current = true
    try {
      while (waiting.current.length > 0) {
        const batch = mergeInputs(waiting.current)
        waiting.current = []
        for (const input of batch) {
          if (input.kind === 'scroll') input.dy = Math.max(-5000, Math.min(5000, input.dy ?? 0))
          await send.mutateAsync({ ...input, picture: picture.current })
        }
      }
    } catch {
      waiting.current = [] // the error is shown through `error`; drop what was queued behind it
    } finally {
      sending.current = false
    }
  }

  const push = (input: BrowserInput) => {
    waiting.current.push(input)
    window.clearTimeout(timer.current)
    const collect = input.kind === 'type' || input.kind === 'scroll'
    timer.current = window.setTimeout(() => void flush(), collect ? COLLECT_MS : 0)
  }

  return { push, error: send.error, busy: send.isPending }
}
