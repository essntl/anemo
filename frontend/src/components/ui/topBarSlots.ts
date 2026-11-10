/**
 * Where page headers go: the two parts of the app's top bar. The bar registers them
 * here and <PageHeader> draws into them.
 */
/** The two parts of the app's top bar that a page fills, once the bar is on the page. */
export type Slots = { start: HTMLElement | null; end: HTMLElement | null }
let slots: Slots = { start: null, end: null }
const listeners = new Set<() => void>()
export const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function setSlot(key: keyof Slots, el: HTMLElement | null) {
  if (slots[key] === el) return
  slots = { ...slots, [key]: el }
  listeners.forEach((l) => l())
}
/** Refs for the top bar's two parts (TopBar in app/mobileNav.tsx): where page headers go. */
export const topBarStart = (el: HTMLElement | null) => setSlot('start', el)
export const topBarEnd = (el: HTMLElement | null) => setSlot('end', el)
export const getSlots = () => slots
