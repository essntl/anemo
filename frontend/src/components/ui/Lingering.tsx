import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ClosingContext, EXIT_LIMIT_MS } from './closing'

/**
 * Keeps a dialog on screen for a moment after it was closed, so it can animate out.
 *
 * Most dialogs here are shown with `{editing && <SomeDialog … />}`: when `editing`
 * is cleared the dialog is gone at once, with no chance to animate. Write this instead:
 *
 *   <Lingering value={editing}>{(e) => <SomeDialog item={e.item} onClose={…} />}</Lingering>
 *
 * It renders the dialog while `value` is set, and afterwards with the last value until
 * <Dialog> reports that its closing animation has ended (or EXIT_LIMIT_MS has passed).
 */
export function Lingering<T>({ value, children }: { value: T | null | undefined | false; children: (value: T) => ReactNode }) {
  const [last, setLast] = useState<T | null>(value || null)
  // Remember the newest value while it is set (adjusting state during render is fine
  // for this: https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  if (value && value !== last) setLast(value)

  const done = useCallback(() => setLast(null), [])
  useEffect(() => {
    if (value || last === null) return
    const timer = window.setTimeout(done, EXIT_LIMIT_MS)
    return () => window.clearTimeout(timer)
  }, [value, last, done])

  const closing = !value
  const context = useMemo(() => ({ closing, done }), [closing, done])
  const shown = value || last
  if (!shown) return null
  return <ClosingContext.Provider value={context}>{children(shown)}</ClosingContext.Provider>
}
