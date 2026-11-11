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
  House,
  Music,
  ChartColumn,
  Timer,
  type LucideIcon,
  MessagesSquare,
  Settings,
  SquarePen,
} from 'lucide-react'
import { isOffAddress, type PageId } from '@/features/settings/navigation'
import { visibleSections } from '@/features/settings/sections'
import { msg, t } from '@/lib/i18n'

export interface PageLink {
  label: string
  /** A section of Settings: its name alone. Shown as "Settings: <name>" (see `pageLabel`). */
  section?: string
  to: string
  icon: LucideIcon
  /** Other words people might type to find it. */
  keywords?: string
  /** Only offered once something is typed (the sections of Settings): keeps the start list short. */
  onlyWhenSearching?: boolean
}

/** Every page; `matchingPages` leaves out the ones that are turned off (Settings > Pages). */
export const PAGES: PageLink[] = [
  { label: msg('Home'), to: '/home', icon: House, keywords: msg('start dashboard widgets today') },
  { label: msg('New chat'), to: '/', icon: SquarePen, keywords: msg('start conversation') },
  { label: msg('Focus'), to: '/focus', icon: Timer, keywords: msg('timer pomodoro concentrate') },
  { label: msg('Music'), to: '/music', icon: Music, keywords: msg('player queue playlists songs ambient') },
  { label: msg('Stats'), to: '/stats', icon: ChartColumn, keywords: msg('statistics focus time streak heatmap') },
  { label: msg('All chats'), to: '/chats', icon: MessagesSquare, keywords: msg('conversations history archive favorites') },
  { label: msg('Projects'), to: '/projects', icon: FolderKanban, keywords: msg('workspace') },
  { label: msg('Files'), to: '/files', icon: FolderOpen, keywords: msg('workspace folder upload') },
  { label: msg('Documents'), to: '/documents', icon: FileText, keywords: msg('notes write markdown') },
  { label: msg('Tasks'), to: '/tasks', icon: CheckSquare, keywords: msg('todo board') },
  { label: msg('Calendar'), to: '/calendar', icon: CalendarDays, keywords: msg('events schedule') },
  { label: msg('Runs'), to: '/runs', icon: History, keywords: msg('agent history activity') },
  { label: msg('Automations'), to: '/automations', icon: Clock, keywords: msg('schedule cron recurring') },
  { label: msg('Profiles & Skills'), to: '/agents', icon: Bot, keywords: msg('agent profile skill') },
  { label: msg('Memory'), to: '/memory', icon: Brain, keywords: msg('remember') },
  { label: msg('Inbox'), to: '/notifications', icon: Bell, keywords: msg('notifications reminders alerts approvals needs you') },
  { label: msg('Settings'), to: '/settings', icon: Settings, keywords: msg('preferences') },
  ...visibleSections([]).map((s) => ({
    label: `Settings: ${s.label}`, section: s.label, to: `/settings/${s.to}`, icon: Settings, keywords: msg('preferences'), onlyWhenSearching: true,
  })),
]

/** The name of a page as it is shown, in the current language. */
export function pageLabel(page: PageLink): string {
  return page.section ? t('Settings: {section}', { section: t(page.section) }) : t(page.label)
}

/**
 * Pages whose name or keywords, in English or the current language, contain every word typed.
 * Without a query: the main pages (the sections of Settings appear once you type).
 * `off`: the pages that are turned off; they, and Settings sections only about them, are not offered.
 */
export function matchingPages(query: string, off: readonly PageId[] = []): PageLink[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const sections = new Set(visibleSections(off).map((s) => `/settings/${s.to}`))
  const on = PAGES.filter((page) => !isOffAddress(page.to, off) && (!page.section || sections.has(page.to)))
  if (words.length === 0) return on.filter((page) => !page.onlyWhenSearching)
  return on.filter((page) => {
    const haystack = `${page.label} ${page.keywords ?? ''} ${pageLabel(page)} ${page.keywords ? t(page.keywords) : ''}`.toLowerCase()
    return words.every((w) => haystack.includes(w))
  })
}
