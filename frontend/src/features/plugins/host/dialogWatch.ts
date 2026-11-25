/**
 * Whether anything is on screen that a plugin overlay must never be drawn over: any dialog
 * or alert dialog (confirmations, the password prompt, a plugin call's Allow/Deny, the
 * command palette, the phone menu…), the opened Dynamic Island, or a part of the page that
 * asks for it with `data-hides-plugin-overlays` (a plugin's review).
 *
 * Overlays are already drawn below every dialog (z-index); hiding them as well means a
 * plugin can't paint something next to a prompt that looks like part of it. The check runs
 * in a MutationObserver, which fires before the browser paints the change, so an overlay is
 * hidden from the very first frame a dialog shows.
 */
import { useSyncExternalStore } from 'react'

export const BLOCKING_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[data-overlay="open"]',
  '[data-hides-plugin-overlays]',
].join(', ')

export function anyDialogOpen(doc: Document = document): boolean {
  return doc.querySelector(BLOCKING_SELECTOR) !== null
}

/** Calls `fn` whenever that changes. Returns a function that stops watching. */
export function watchDialogs(fn: (open: boolean) => void, doc: Document = document): () => void {
  let open = anyDialogOpen(doc)
  const observer = new MutationObserver(() => {
    const now = anyDialogOpen(doc)
    if (now === open) return
    open = now
    fn(now)
  })
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-state', 'data-overlay', 'role', 'data-hides-plugin-overlays'],
  })
  return () => observer.disconnect()
}

const subscribe = (onChange: () => void) => watchDialogs(onChange)

/** True while something is open that overlays must stay hidden for. */
export function useDialogOpen(): boolean {
  return useSyncExternalStore(subscribe, () => anyDialogOpen(), () => false)
}
