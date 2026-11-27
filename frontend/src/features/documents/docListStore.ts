import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** How the documents in the list are put into groups (docs/specs/26-document-organisation.md). */
export type GroupBy = 'folder' | 'type' | 'status' | 'changed'
/** How the documents of a group are ordered. */
export type SortBy = 'title' | 'changed'

export interface ListView {
  groupBy: GroupBy
  sortBy: SortBy
  /** Groups folded (true) or opened (false) by hand; the Archived group starts folded. */
  folded: Record<string, boolean>
  /** Leave the Archived group out completely. */
  hideArchived: boolean
}

export const DEFAULT_VIEW: ListView = { groupBy: 'folder', sortBy: 'title', folded: {}, hideArchived: false }
/** The place outside projects (Uncategorized and All share it). */
export const OUTSIDE = 'outside'

interface DocListState {
  /** One view for each project (by id), and one outside projects (`OUTSIDE`). */
  views: Record<string, ListView>
  change: (place: string, change: Partial<ListView>) => void
  fold: (place: string, group: string, folded: boolean) => void
}

/** The list's group-by, sort and folded groups, remembered on this device per project. */
export const useDocListStore = create<DocListState>()(
  persist(
    (set) => ({
      views: {},
      change: (place, change) =>
        set((s) => ({ views: { ...s.views, [place]: { ...DEFAULT_VIEW, ...s.views[place], ...change } } })),
      fold: (place, group, folded) =>
        set((s) => {
          const view = { ...DEFAULT_VIEW, ...s.views[place] }
          return { views: { ...s.views, [place]: { ...view, folded: { ...view.folded, [group]: folded } } } }
        }),
    }),
    { name: 'anemo.docList.view' },
  ),
)

/** The view of one place, with the defaults for what was never chosen. */
export function useListView(place: string): ListView {
  const stored = useDocListStore((s) => s.views[place])
  return stored ? { ...DEFAULT_VIEW, ...stored } : DEFAULT_VIEW
}
