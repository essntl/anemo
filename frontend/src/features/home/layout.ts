/**
 * The Home page layout: which widgets, in what order, how big. Stored on the server
 * (Settings section `home`), so the phone and the desktop share it; phones always
 * show one column.
 *
 * `normalizeLayout` keeps a saved layout usable as widgets are added to or removed
 * from the app: unknown widgets are dropped, missing ones are added (with their
 * default size, at the end), sizes are clamped, duplicates removed.
 */

export const WIDGET_IDS = ['focus', 'today', 'music', 'needs', 'week', 'tasks', 'ask', 'documents', 'upcoming', 'briefing'] as const
export type WidgetId = (typeof WIDGET_IDS)[number]

export interface WidgetLayout {
  id: WidgetId
  /** Columns spanned, 1–3 (capped by the screen's columns). */
  w: number
  /** Rows spanned, 1–3. */
  h: number
  hidden?: boolean
  /** "Needs you" shows even when there is nothing (otherwise it hides itself). */
  pinned?: boolean
  options?: Record<string, string | null>
}

export const MAX_SPAN = 3

export const WIDGETS: Record<WidgetId, { name: string; path: string }> = {
  focus: { name: 'Focus', path: '/focus' },
  today: { name: 'Today', path: '/tasks' },
  music: { name: 'Music', path: '/music' },
  needs: { name: 'Needs you', path: '/notifications' },
  week: { name: 'This week', path: '/stats' },
  tasks: { name: 'Tasks', path: '/tasks' },
  ask: { name: 'Ask Anemo', path: '/' },
  documents: { name: 'Recent documents', path: '/documents' },
  upcoming: { name: 'Upcoming', path: '/calendar' },
  briefing: { name: 'Briefing', path: '/automations' },
}

export const DEFAULT_LAYOUT: WidgetLayout[] = [
  { id: 'focus', w: 1, h: 2 },
  { id: 'today', w: 1, h: 2 },
  { id: 'music', w: 1, h: 1 },
  { id: 'needs', w: 1, h: 1 },
  { id: 'ask', w: 2, h: 1 },
  { id: 'week', w: 1, h: 1 },
  { id: 'tasks', w: 1, h: 1 },
  { id: 'upcoming', w: 1, h: 1 },
  { id: 'documents', w: 1, h: 1 },
  { id: 'briefing', w: 1, h: 1, hidden: true },
]

const clampSpan = (n: unknown) => Math.min(MAX_SPAN, Math.max(1, Math.round(Number(n) || 1)))
const known = new Set<string>(WIDGET_IDS)

export function normalizeLayout(saved: unknown): WidgetLayout[] {
  const seen = new Set<string>()
  const out: WidgetLayout[] = []
  for (const raw of Array.isArray(saved) ? saved : []) {
    const r = raw as Partial<WidgetLayout> | null
    const id = r?.id
    if (typeof id !== 'string' || !known.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push({
      id: id as WidgetId,
      w: clampSpan(r!.w),
      h: clampSpan(r!.h),
      hidden: !!r!.hidden,
      pinned: !!r!.pinned,
      options: r!.options && typeof r!.options === 'object' ? { ...r!.options } : {},
    })
  }
  for (const w of DEFAULT_LAYOUT) {
    if (!seen.has(w.id)) out.push({ ...w, hidden: !!w.hidden, pinned: false, options: {} })
  }
  return out
}

/** Move a widget to another position in the list. */
export function moveWidget(layout: WidgetLayout[], id: WidgetId, toIndex: number): WidgetLayout[] {
  const from = layout.findIndex((w) => w.id === id)
  if (from < 0 || from === toIndex) return layout
  const next = [...layout]
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, item)
  return next
}

export function resizeWidget(layout: WidgetLayout[], id: WidgetId, w: number, h: number): WidgetLayout[] {
  const cur = layout.find((x) => x.id === id)
  if (!cur || (cur.w === clampSpan(w) && cur.h === clampSpan(h))) return layout
  return layout.map((x) => (x.id === id ? { ...x, w: clampSpan(w), h: clampSpan(h) } : x))
}

export function patchWidget(layout: WidgetLayout[], id: WidgetId, patch: Partial<Omit<WidgetLayout, 'id'>>): WidgetLayout[] {
  return layout.map((x) => (x.id === id ? { ...x, ...patch } : x))
}

export function resetLayout(): WidgetLayout[] {
  return normalizeLayout(DEFAULT_LAYOUT)
}
