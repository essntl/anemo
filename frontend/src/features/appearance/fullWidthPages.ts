/** The pages with a full-width button of their own, and how their choice combines with the setting (fullWidth.tsx). */
export const WIDTH_PAGES = ['home', 'chat', 'documents', 'tasks', 'code'] as const
export type WidthPage = (typeof WIDTH_PAGES)[number]

/** Whether `page` is full width, given the setting and the page's own choice. */
export function isFullWidth(page: WidthPage, setting: boolean, pages: Partial<Record<string, boolean>>): boolean {
  return pages[page] ?? setting
}

/** The page's own choice: `on`, or none when that is what the setting says anyway. */
export function withPageChoice(pages: Partial<Record<string, boolean>>, page: WidthPage, on: boolean, setting: boolean): Record<string, boolean> {
  const next: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(pages)) if (typeof v === 'boolean' && k !== page) next[k] = v
  if (on !== setting) next[page] = on
  return next
}
