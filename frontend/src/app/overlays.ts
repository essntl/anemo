/**
 * What is open over the page, and how to close the topmost of it.
 *
 * Every dialog, sheet, drawer, menu and dropdown of the app is a Radix dialog, popover or
 * select, which carry `data-state="open"` and a role while they show. Anything built
 * otherwise marks itself with `data-overlay="open"` (the opened Dynamic Island). All of
 * them close on Esc, the topmost first, so closing "the top one" is an Esc key press.
 */
const OPEN = '[data-state="open"]:is([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]), [data-overlay="open"]'

/** How many dialogs, sheets, drawers, menus and dropdowns are open. */
export function openOverlays(): number {
  return document.querySelectorAll(OPEN).length
}

/** Closes the topmost one, the way the Esc key does. */
export function closeTopOverlay(): void {
  const target = document.activeElement ?? document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
}
