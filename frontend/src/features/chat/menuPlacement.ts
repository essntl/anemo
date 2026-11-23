/** Where the message box's skills menu goes: above or below the box, and how tall its list may be. */
export interface MenuPlacement {
  below: boolean
  /** The list's height limit (px). */
  listMax: number
}

interface Span {
  top: number
  bottom: number
}

/** The list's height when there is room for it (px). */
export const LIST_MAX = 288
/** Never shorter than this, even where there's hardly any room: a couple of skills. */
const LIST_MIN = 96
/** Between the box and the menu (px). */
const GAP = 8
/** Kept free between the menu and the edge of what can be seen (px). */
const MARGIN = 8

/**
 * Above the box when the menu fits there (where it is out of the way); otherwise on the
 * side with more room. Where even that is too small the list gets shorter, so the menu is
 * never cut off.
 * @param chrome the menu's height without its list (its heading and "Manage skills")
 * @param list the list's own height (all its skills)
 */
export function placeMenu(box: Span, area: Span, chrome: number, list: number): MenuPlacement {
  const want = chrome + Math.min(list, LIST_MAX)
  const above = box.top - area.top - GAP - MARGIN
  const below = area.bottom - box.bottom - GAP - MARGIN
  const goBelow = above < want && below > above
  const room = goBelow ? below : above
  return { below: goBelow, listMax: Math.max(LIST_MIN, Math.min(LIST_MAX, room - chrome)) }
}

/** The part of the window where something inside `el` can be seen: within every ancestor that clips it. */
export function visibleArea(el: HTMLElement): Span {
  let top = 0
  let bottom = window.innerHeight
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    if (getComputedStyle(parent).overflowY === 'visible') continue
    const rect = parent.getBoundingClientRect()
    top = Math.max(top, rect.top)
    bottom = Math.min(bottom, rect.bottom)
  }
  return { top, bottom }
}
