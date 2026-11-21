import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import { dictation } from './dictationStore'

/**
 * Makes a message box a place for dictated text: where it goes when no text field had the
 * focus, and where it waits after a new chat was opened for it (`onPending` gets that).
 */
export function useDictationMessageBox(box: RefObject<HTMLTextAreaElement | null>, onPending: (text: string) => void) {
  const latest = useRef(onPending)
  useLayoutEffect(() => {
    latest.current = onPending
  })
  useEffect(() => {
    const el = box.current
    if (!el) return
    const pending = dictation.takePendingText()
    if (pending) latest.current(pending)
    return dictation.addMessageBox(el)
  }, [box])
}
