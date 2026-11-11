/**
 * Where each page of the app goes: in the sidebar's list ("pinned"), behind "More", or
 * off. Chosen in Settings > Pages and stored on the server (settings section
 * `navigation`), so every device shows the same. A page that is off is in no menu and
 * not in search, its address leads Home, and the agents don't get its tools.
 */
import {
  Bot, Brain, CalendarDays, CheckSquare, Clock, FileText, FolderKanban, FolderOpen, History, House, Inbox, type LucideIcon, Music, Timer,
} from 'lucide-react'
import type { Schemas } from '@/api/client'
import { msg } from '@/lib/i18n'
import { useSettings } from './api'

export type PageId = NonNullable<Schemas['NavigationSettings']['pinned']>[number]
/** The three lists; every page is in exactly one. */
export interface Navigation {
  pinned: PageId[]
  more: PageId[]
  off: PageId[]
}
export type Place = 'pinned' | 'more' | 'off'
export const PLACES: Place[] = ['pinned', 'more', 'off']

export interface PageInfo {
  /** Its address; pages inside it (/runs/…) belong to it too. */
  to: string
  icon: LucideIcon
  label: string
  /** The full name, when `label` is a short one. */
  title?: string
  /** Other addresses that are part of it. */
  alsoAt?: string[]
  /** Turning it off also takes its tools from the agents. */
  hasTools?: boolean
}

export const PAGE_INFO: Record<PageId, PageInfo> = {
  home: { to: '/home', icon: House, label: msg('Home') },
  notifications: { to: '/notifications', icon: Inbox, label: msg('Inbox') },
  tasks: { to: '/tasks', icon: CheckSquare, label: msg('Tasks'), hasTools: true },
  calendar: { to: '/calendar', icon: CalendarDays, label: msg('Calendar'), hasTools: true },
  documents: { to: '/documents', icon: FileText, label: msg('Documents') },
  files: { to: '/files', icon: FolderOpen, label: msg('Files') },
  projects: { to: '/projects', icon: FolderKanban, label: msg('Projects') },
  focus: { to: '/focus', icon: Timer, label: msg('Focus'), alsoAt: ['/stats'], hasTools: true },
  music: { to: '/music', icon: Music, label: msg('Music'), hasTools: true },
  runs: { to: '/runs', icon: History, label: msg('Runs') },
  automations: { to: '/automations', icon: Clock, label: msg('Automations'), hasTools: true },
  agents: { to: '/agents', icon: Bot, label: msg('Agents'), title: msg('Profiles & Skills') },
  memory: { to: '/memory', icon: Brain, label: msg('Memory') },
}
export const PAGE_IDS = Object.keys(PAGE_INFO) as PageId[]

/** Home is where the app opens and the Inbox is where approvals wait: these cannot be turned off. */
export const ALWAYS_ON: readonly PageId[] = ['home', 'notifications']

export const DEFAULT_NAVIGATION: Navigation = {
  pinned: ['home', 'notifications', 'tasks', 'calendar', 'documents', 'files'],
  more: ['projects', 'focus', 'music', 'runs', 'automations', 'agents', 'memory'],
  off: [],
}

/**
 * A saved choice made usable: unknown pages and repeats are dropped, a page that is in
 * no list (one added in a later version) goes under "More", and Home and the Inbox are
 * never off.
 */
export function normalizeNavigation(saved: Partial<Navigation> | undefined): Navigation {
  if (!saved) return DEFAULT_NAVIGATION
  const seen = new Set<PageId>()
  const take = (ids: readonly string[] | undefined, allow: (id: PageId) => boolean = () => true) =>
    (ids ?? []).filter((id): id is PageId => {
      if (!(id in PAGE_INFO) || seen.has(id as PageId) || !allow(id as PageId)) return false
      seen.add(id as PageId)
      return true
    })
  const off = take(saved.off, (id) => !ALWAYS_ON.includes(id))
  const pinned = take(saved.pinned)
  const more = take(saved.more)
  return { pinned, more: [...more, ...PAGE_IDS.filter((id) => !seen.has(id))], off }
}

export const placeOf = (navigation: Navigation, id: PageId): Place =>
  navigation.pinned.includes(id) ? 'pinned' : navigation.off.includes(id) ? 'off' : 'more'

/** The page moved to the end of another list. */
export function movePage(navigation: Navigation, id: PageId, place: Place): Navigation {
  if (place === 'off' && ALWAYS_ON.includes(id)) return navigation
  const without = (ids: PageId[]) => ids.filter((other) => other !== id)
  const next = { pinned: without(navigation.pinned), more: without(navigation.more), off: without(navigation.off) }
  next[place] = [...next[place], id]
  return next
}

/** The page one step up (-1) or down (1) in its list. */
export function shiftPage(navigation: Navigation, id: PageId, by: -1 | 1): Navigation {
  const place = placeOf(navigation, id)
  const ids = [...navigation[place]]
  const from = ids.indexOf(id)
  const to = from + by
  if (from < 0 || to < 0 || to >= ids.length) return navigation
  ;[ids[from], ids[to]] = [ids[to], ids[from]]
  return { ...navigation, [place]: ids }
}

const within = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`)

/** The page an address belongs to, if it is one of these. */
export function pageAt(pathname: string): PageId | undefined {
  return PAGE_IDS.find((id) => [PAGE_INFO[id].to, ...(PAGE_INFO[id].alsoAt ?? [])].some((to) => within(pathname, to)))
}

/** Whether the address is of a page that is turned off. */
export function isOffAddress(pathname: string, off: readonly PageId[]): boolean {
  const id = pageAt(pathname.split(/[?#]/)[0])
  return id !== undefined && off.includes(id)
}

/** The saved choice (the default one until the settings have loaded). */
export function useNavigation(): Navigation {
  return normalizeNavigation(useSettings().data?.navigation)
}

/** The pages that are turned off. */
export function useOffPages(): PageId[] {
  return useNavigation().off
}
