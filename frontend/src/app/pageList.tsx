import { Bot, Brain, CalendarDays, CheckSquare, Clock, FileText, FolderKanban, FolderOpen, History, House, Inbox, Music, Timer } from 'lucide-react'
import { InboxBadge, MemoryBadge, RunsBadge } from './badges'
import type { PageEntry } from './PagesFolder'

/** The pages always in the list, and the ones behind "More" (desktop). A phone shows all of them in its Pages card. */
export const PINNED: PageEntry[] = [
  { to: '/home', icon: <House />, label: 'Home' },
  { to: '/notifications', icon: <Inbox />, label: 'Inbox', badge: <InboxBadge /> },
  { to: '/tasks', icon: <CheckSquare />, label: 'Tasks' },
  { to: '/calendar', icon: <CalendarDays />, label: 'Calendar' },
  { to: '/documents', icon: <FileText />, label: 'Documents' },
  { to: '/files', icon: <FolderOpen />, label: 'Files' },
]
export const MORE: PageEntry[] = [
  { to: '/projects', icon: <FolderKanban />, label: 'Projects' },
  { to: '/focus', icon: <Timer />, label: 'Focus' },
  { to: '/music', icon: <Music />, label: 'Music' },
  { to: '/runs', icon: <History />, label: 'Runs', badge: <RunsBadge /> },
  { to: '/automations', icon: <Clock />, label: 'Automations' },
  { to: '/agents', icon: <Bot />, label: 'Agents', title: 'Profiles & Skills' },
  { to: '/memory', icon: <Brain />, label: 'Memory', badge: <MemoryBadge /> },
]
