/** The pages you can jump to from the search box (Ctrl+K), matched by name or keyword. */
import {
  Bell,
  Bot,
  Brain,
  CalendarDays,
  CheckSquare,
  Clock,
  FileText,
  FolderKanban,
  FolderOpen,
  History,
  type LucideIcon,
  MessagesSquare,
  Settings,
  SquarePen,
} from 'lucide-react'
import { SETTINGS_SECTIONS } from '@/features/settings/sections'

export interface PageLink {
  label: string
  to: string
  icon: LucideIcon
  /** Other words people might type to find it. */
  keywords?: string
  /** Only offered once something is typed (the sections of Settings): keeps the start list short. */
  onlyWhenSearching?: boolean
}

export const PAGES: PageLink[] = [
  { label: 'New chat', to: '/', icon: SquarePen, keywords: 'start conversation' },
  { label: 'All chats', to: '/chats', icon: MessagesSquare, keywords: 'conversations history archive favorites' },
  { label: 'Projects', to: '/projects', icon: FolderKanban, keywords: 'workspace' },
  { label: 'Files', to: '/files', icon: FolderOpen, keywords: 'workspace folder upload' },
  { label: 'Documents', to: '/documents', icon: FileText, keywords: 'notes write markdown' },
  { label: 'Tasks', to: '/tasks', icon: CheckSquare, keywords: 'todo board' },
  { label: 'Calendar', to: '/calendar', icon: CalendarDays, keywords: 'events schedule' },
  { label: 'Runs', to: '/runs', icon: History, keywords: 'agent history activity' },
  { label: 'Automations', to: '/automations', icon: Clock, keywords: 'schedule cron recurring' },
  { label: 'Profiles & Skills', to: '/agents', icon: Bot, keywords: 'agent profile skill' },
  { label: 'Memory', to: '/memory', icon: Brain, keywords: 'remember' },
  { label: 'Notifications', to: '/notifications', icon: Bell, keywords: 'reminders alerts' },
  { label: 'Settings', to: '/settings', icon: Settings, keywords: 'preferences' },
  ...SETTINGS_SECTIONS.map((s) => ({
    label: `Settings: ${s.label}`, to: `/settings/${s.to}`, icon: Settings, keywords: 'preferences', onlyWhenSearching: true,
  })),
]

/**
 * Pages whose name or keywords contain every word typed.
 * Without a query: the main pages (the sections of Settings appear once you type).
 */
export function matchingPages(query: string): PageLink[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return PAGES.filter((page) => !page.onlyWhenSearching)
  return PAGES.filter((page) => {
    const haystack = `${page.label} ${page.keywords ?? ''}`.toLowerCase()
    return words.every((w) => haystack.includes(w))
  })
}
