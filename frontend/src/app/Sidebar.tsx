import type { ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router'
import {
  Bell,
  Bot,
  Brain,
  CalendarDays,
  CheckSquare,
  ChevronRight,
  Clock,
  FileText,
  FolderKanban,
  FolderOpen,
  History,
  LogOut,
  MessagesSquare,
  Plus,
  Search,
  Settings,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Logo } from '@/components/ui/Logo'
import { Select } from '@/components/ui/Select'
import { useLogout, useMe } from '@/features/auth/api'
import { ConversationList } from '@/features/chat/components/ConversationList'
import { useMemorySummary } from '@/features/memory/api'
import { useNotificationSummary } from '@/features/notifications/api'
import { useRunsSummary } from '@/features/runs/api'
import { useProjects } from '@/features/tasks/api'
import { usePalette } from '@/features/search/paletteStore'
import { cn } from '@/lib/cn'
import { useCurrentProject, useProjectStore } from './projectStore'
import { useSidebar } from './sidebarStore'

function NavItem({ to, icon, children, badge }: { to: string; icon: ReactNode; children: ReactNode; badge?: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'flex h-9 items-center gap-2.5 rounded-control px-3 text-[13px] font-medium transition-colors pointer-coarse:h-11 pointer-coarse:text-[15px]',
          isActive
            ? 'bg-accent-soft text-accent'
            : 'text-muted hover:bg-surface-hover hover:text-text',
        )
      }
    >
      <span className="[&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      <span className="flex-1">{children}</span>
      {badge}
    </NavLink>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-3 first:mt-1">
      <div className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">
        {label}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  )
}

/** Agent runs that are working, or that wait for the user (approval or paused). */
function RunsBadge() {
  const summary = useRunsSummary()
  const { active = 0, waiting = 0 } = summary.data ?? {}
  if (waiting) {
    return (
      <span title={`${waiting} waiting for you`}
        className="flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-[11px] font-semibold text-white">
        {waiting}
      </span>
    )
  }
  if (active) return <span title={`${active} running`} className="h-2 w-2 animate-pulse rounded-full bg-accent" />
  return null
}

/** Memory suggestions waiting for the user's decision. */
function MemoryBadge() {
  const pending = useMemorySummary().data?.pending ?? 0
  if (!pending) return null
  return (
    <span title={`${pending} suggestion${pending === 1 ? '' : 's'} to review`}
      className="flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-[11px] font-semibold text-white">
      {pending}
    </span>
  )
}

/** Notifications not opened yet. */
function NotificationsBadge() {
  const unread = useNotificationSummary().data?.unread ?? 0
  if (!unread) return null
  return (
    <span title={`${unread} unread`}
      className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-contrast">
      {unread > 99 ? '99+' : unread}
    </span>
  )
}

/** The project you are working in. "All projects" shows everything together. */
function ProjectSwitcher() {
  const navigate = useNavigate()
  const projects = useProjects()
  const current = useCurrentProject()
  const setProjectId = useProjectStore((s) => s.setProjectId)
  const active = (projects.data ?? []).filter((p) => !p.archived)
  const dot = (color: string) => <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
  return (
    <Select
      aria-label="Project"
      className="mt-2 h-9"
      value={current?.id ?? ''}
      onValueChange={(value) => (value === MANAGE ? void navigate('/projects') : setProjectId(value || null))}
      options={[
        { value: '', label: 'All projects' },
        ...active.map((p) => ({ value: p.id, label: <>{dot(p.color)}{p.name}</> })),
        { value: MANAGE, label: active.length ? 'Manage projects…' : 'Create a project…' },
      ]}
    />
  )
}
const MANAGE = '__manage__'

/** What the closed menu would hide: runs waiting for you and memory suggestions. */
function MenuBadge() {
  const waiting = useRunsSummary().data?.waiting ?? 0
  const pending = useMemorySummary().data?.pending ?? 0
  if (!waiting && !pending) return null
  return (
    <span title="Something in here is waiting for you"
      className="flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-[11px] font-semibold text-white">
      {waiting + pending}
    </span>
  )
}

/** `onClose` is set when the sidebar is shown in the phone drawer. */
export function Sidebar({ className, onClose }: { className?: string; onClose?: () => void }) {
  const navigate = useNavigate()
  const me = useMe()
  const logout = useLogout()
  const openSearch = usePalette((s) => s.setOpen)
  const { menuOpen, setMenuOpen } = useSidebar()
  return (
    <aside className={cn('h-full shrink-0 flex-col border-r border-border bg-surface px-3 py-4', onClose ? 'flex' : '', className)}>
      <div className="mb-4 flex items-center gap-2 px-2">
        <Logo className="h-8 w-8 text-accent pointer-coarse:h-9 pointer-coarse:w-9" />
        <span className="flex-1 text-[19px] font-semibold tracking-tight pointer-coarse:text-[22px]">Anemo</span>
        {onClose && (
          <button type="button" aria-label="Close menu" onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text">
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <Button
          variant="primary"
          className="flex-1 justify-center"
          icon={<Plus className="h-4 w-4" />}
          onClick={() => navigate('/')}
        >
          New chat
        </Button>
        {/* Search everything (also Ctrl+K). The box below only filters the chat list. */}
        <Button variant="secondary" size="icon" className="h-10 w-10 shrink-0" aria-label="Search everything"
          title="Search everything (Ctrl+K)" onClick={() => openSearch(true)}>
          <Search className="h-4 w-4" />
        </Button>
      </div>

      <ProjectSwitcher />

      {/* Menu open: chats (up to seven), then the menu; the whole column scrolls.
          Menu closed: the chats take all the room and scroll on their own. */}
      <nav className={cn('mt-1 flex min-h-0 flex-1 flex-col', menuOpen && 'overflow-y-auto')}>
        <ConversationList fill={!menuOpen} />
        <NavLink to="/chats"
          className={({ isActive }) =>
            cn('mt-1 flex h-8 shrink-0 items-center gap-2 rounded-control px-3 text-[12.5px] pointer-coarse:h-10 pointer-coarse:text-[14px]',
              isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-text')}>
          <MessagesSquare className="h-3.5 w-3.5" /> All chats
        </NavLink>

        <button type="button" aria-expanded={menuOpen} aria-controls="sidebar-menu" onClick={() => setMenuOpen(!menuOpen)}
          className="mt-3 flex h-8 shrink-0 items-center gap-1.5 rounded-control px-3 text-[11px] font-semibold uppercase tracking-wider text-subtle hover:bg-surface-hover hover:text-text pointer-coarse:h-10">
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform duration-150', menuOpen && 'rotate-90')} />
          <span className="flex-1 text-left">Workspace &amp; agents</span>
          {!menuOpen && <MenuBadge />}
        </button>
        <div id="sidebar-menu" className="collapsible shrink-0" data-open={menuOpen} inert={!menuOpen}>
          <div>
            <Section label="Workspace">
              <NavItem to="/projects" icon={<FolderKanban />}>Projects</NavItem>
              <NavItem to="/files" icon={<FolderOpen />}>Files</NavItem>
              <NavItem to="/documents" icon={<FileText />}>Documents</NavItem>
              <NavItem to="/tasks" icon={<CheckSquare />}>Tasks</NavItem>
              <NavItem to="/calendar" icon={<CalendarDays />}>Calendar</NavItem>
            </Section>
            <Section label="Agents">
              <NavItem to="/runs" icon={<History />} badge={<RunsBadge />}>Runs</NavItem>
              <NavItem to="/automations" icon={<Clock />}>Automations</NavItem>
              <NavItem to="/agents" icon={<Bot />}>Profiles & Skills</NavItem>
            </Section>
            <Section label="You">
              <NavItem to="/memory" icon={<Brain />} badge={<MemoryBadge />}>Memory</NavItem>
            </Section>
          </div>
        </div>
      </nav>

      <div className="flex flex-col gap-0.5 border-t border-border pt-3">
        <NavItem to="/notifications" icon={<Bell />} badge={<NotificationsBadge />}>Notifications</NavItem>
        <NavItem to="/settings" icon={<Settings />}>Settings</NavItem>
        <button
          type="button"
          onClick={() => logout.mutate()}
          className="flex h-9 items-center gap-2.5 rounded-control px-3 text-[13px] font-medium text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-11 pointer-coarse:text-[15px]"
        >
          <LogOut className="h-4 w-4" />
          Sign out {me.data && <span className="truncate text-subtle">({me.data.username})</span>}
        </button>
      </div>
    </aside>
  )
}
