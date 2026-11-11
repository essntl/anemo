import type { ReactNode } from 'react'
import { PAGE_INFO, type PageId, useNavigation } from '@/features/settings/navigation'
import { t } from '@/lib/i18n'
import { InboxBadge, MemoryBadge, RunsBadge } from './badges'
import type { PageEntry } from './PagesFolder'

/** The counts some pages carry. */
const BADGES: Partial<Record<PageId, ReactNode>> = {
  notifications: <InboxBadge />,
  runs: <RunsBadge />,
  memory: <MemoryBadge />,
}

function entry(id: PageId): PageEntry {
  const { to, icon: Icon, label, title } = PAGE_INFO[id]
  return { to, icon: <Icon />, label: t(label), title: title && t(title), badge: BADGES[id] }
}

/**
 * The pages always in the sidebar's list, and the ones behind "More" (desktop), as
 * chosen in Settings > Pages; pages that are turned off are in neither. A phone shows
 * all of them in its Pages card.
 */
export function usePages(): { pinned: PageEntry[]; more: PageEntry[] } {
  const navigation = useNavigation()
  return { pinned: navigation.pinned.map(entry), more: navigation.more.map(entry) }
}
