/** The pages you can jump to from the search box (Ctrl+K), matched by name or keyword. */
import { SETTINGS_SECTIONS } from '@/features/settings/sections'

export interface PageLink {
  label: string
  to: string
  /** Other words people might type to find it. */
  keywords?: string
}

export const PAGES: PageLink[] = [
  { label: 'New chat', to: '/', keywords: 'start conversation' },
  { label: 'Files', to: '/files', keywords: 'workspace folder upload' },
  { label: 'Documents', to: '/documents', keywords: 'notes write markdown' },
  { label: 'Tasks', to: '/tasks', keywords: 'todo board' },
  { label: 'Calendar', to: '/calendar', keywords: 'events schedule' },
  { label: 'Runs', to: '/runs', keywords: 'agent history activity' },
  { label: 'Automations', to: '/automations', keywords: 'schedule cron recurring' },
  { label: 'Profiles & Skills', to: '/agents', keywords: 'agent profile skill' },
  { label: 'Memory', to: '/memory', keywords: 'remember' },
  { label: 'Notifications', to: '/notifications', keywords: 'reminders alerts' },
  ...SETTINGS_SECTIONS.map((s) => ({ label: `Settings: ${s.label}`, to: `/settings/${s.to}`, keywords: 'preferences' })),
]

/** Pages whose name or keywords contain every word typed. Without a query: all of them. */
export function matchingPages(query: string): PageLink[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return PAGES.filter((page) => {
    const haystack = `${page.label} ${page.keywords ?? ''}`.toLowerCase()
    return words.every((w) => haystack.includes(w))
  })
}
