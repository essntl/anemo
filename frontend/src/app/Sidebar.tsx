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
  PanelLeftClose,
  PanelLeftOpen,
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

/** One page in the pinned grid under the chats: an icon and a short name. */
function PageLink({ to, icon, children, title, badge }: { to: string; icon: ReactNode; children: ReactNode; title?: string; badge?: ReactNode }) {
  return (
    <NavLink to={to} title={title}
      className={({ isActive }) =>
        cn('flex h-8 min-w-0 items-center gap-1.5 rounded-control px-2 text-[12.5px] font-medium transition-colors pointer-coarse:h-10 pointer-coarse:text-[14px]',
          isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-text')}>
      <span className="shrink-0 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {badge}
    </NavLink>
  )
}

/** One page in the phone menu's grid: the icon above a short name, badge on the corner. */
function PageTile({ to, icon, children, title, badge }: { to: string; icon: ReactNode; children: ReactNode; title?: string; badge?: ReactNode }) {
  return (
    <NavLink to={to} title={title}
      className={({ isActive }) =>
        cn('relative flex h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-control px-1 text-[12px] font-medium transition-colors',
          isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-text')}>
      <span className="[&>svg]:h-5 [&>svg]:w-5">{icon}</span>
      <span className="w-full truncate text-center">{children}</span>
      {badge && <span className="absolute right-1.5 top-1 scale-90">{badge}</span>}
    </NavLink>
  )
}

/** A round icon button in the phone menu's header. */
function HeaderLink({ to, label, icon, badge, onClick }: { to: string; label: string; icon: ReactNode; badge?: ReactNode; onClick?: () => void }) {
  return (
    <NavLink to={to} aria-label={label} title={label} onClick={onClick}
      className={({ isActive }) =>
        cn('relative flex h-10 w-10 items-center justify-center rounded-control [&>svg]:h-5 [&>svg]:w-5',
          isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-text')}>
      {icon}
      {badge && <span className="absolute -right-0.5 -top-0.5 scale-75">{badge}</span>}
    </NavLink>
  )
}

/** A thin line in the accent colour that fades out: sets the parts of the sidebar apart. */
function Divider({ className }: { className?: string }) {
  return <div aria-hidden className={cn('h-px shrink-0 bg-[linear-gradient(to_right,var(--accent),transparent)] opacity-50', className)} />
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

/** The project you are working in. "All projects" shows everything together.
 *  `compact`: a small pill beside the chat search (the phone menu). */
function ProjectSwitcher({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate()
  const projects = useProjects()
  const current = useCurrentProject()
  const setProjectId = useProjectStore((s) => s.setProjectId)
  const active = (projects.data ?? []).filter((p) => !p.archived)
  const dot = (color: string) => <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
  return (
    <Select
      aria-label="Project"
      variant={compact ? 'pill' : 'field'}
      className={compact ? 'max-w-[9rem] shrink-0 pointer-coarse:h-10' : 'mt-2 h-9'}
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

/** One page in the folded sidebar: an icon, with its name as a tooltip. */
function RailLink({ to, label, icon, badge }: { to: string; label: string; icon: ReactNode; badge?: ReactNode }) {
  return (
    <NavLink to={to} title={label} aria-label={label}
      className={({ isActive }) =>
        cn('relative flex h-9 w-9 shrink-0 items-center justify-center rounded-control transition-colors [&>svg]:h-4 [&>svg]:w-4',
          isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-text')}>
      {icon}
      {badge && <span className="absolute -right-1 -top-1 scale-75">{badge}</span>}
    </NavLink>
  )
}

/** The sidebar folded to a strip of icons (desktop only). */
export function SidebarRail({ className }: { className?: string }) {
  const navigate = useNavigate()
  const openSearch = usePalette((s) => s.setOpen)
  const setCollapsed = useSidebar((s) => s.setCollapsed)
  const button = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text'
  return (
    <nav aria-label="Menu" className={cn('h-full w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border bg-surface py-4', className)}>
      <button type="button" aria-label="Show the sidebar" title="Show the sidebar (Ctrl+\)" onClick={() => setCollapsed(false)} className={button}>
        <PanelLeftOpen className="h-4 w-4" />
      </button>
      <Button variant="primary" size="icon" className="mt-2 shrink-0" aria-label="New chat" title="New chat" onClick={() => navigate('/')}>
        <Plus className="h-4 w-4" />
      </Button>
      <button type="button" aria-label="Search everything" title="Search everything (Ctrl+K)" onClick={() => openSearch(true)} className={button}>
        <Search className="h-4 w-4" />
      </button>
      <RailLink to="/chats" label="All chats" icon={<MessagesSquare />} />
      <Divider className="my-2 w-8" />
      <RailLink to="/projects" label="Projects" icon={<FolderKanban />} />
      <RailLink to="/files" label="Files" icon={<FolderOpen />} />
      <RailLink to="/documents" label="Documents" icon={<FileText />} />
      <RailLink to="/tasks" label="Tasks" icon={<CheckSquare />} />
      <RailLink to="/calendar" label="Calendar" icon={<CalendarDays />} />
      <RailLink to="/runs" label="Runs" icon={<History />} badge={<RunsBadge />} />
      <RailLink to="/automations" label="Automations" icon={<Clock />} />
      <RailLink to="/agents" label="Profiles & Skills" icon={<Bot />} />
      <RailLink to="/memory" label="Memory" icon={<Brain />} badge={<MemoryBadge />} />
      <Divider className="mb-2 mt-auto w-8" />
      <RailLink to="/notifications" label="Notifications" icon={<Bell />} badge={<NotificationsBadge />} />
      <RailLink to="/settings" label="Settings" icon={<Settings />} />
    </nav>
  )
}

/** `onClose` is set when the sidebar is shown in the phone drawer. */
export function Sidebar({ className, onClose }: { className?: string; onClose?: () => void }) {
  const navigate = useNavigate()
  const me = useMe()
  const logout = useLogout()
  const openSearch = usePalette((s) => s.setOpen)
  const setCollapsed = useSidebar((s) => s.setCollapsed)
  const Page = onClose ? PageTile : PageLink
  return (
    // Normally nothing here scrolls but the chats; in a very low window the sidebar as a
    // whole does, rather than squeezing the chats away.
    <aside className={cn('h-full shrink-0 flex-col overflow-y-auto border-r border-border bg-surface px-3 py-4', onClose ? 'flex' : '', className)}>
      <div className={cn('flex items-center gap-2 px-2', onClose ? 'mb-3 gap-1' : 'mb-4')}>
        <Logo className="h-8 w-8 text-accent pointer-coarse:h-9 pointer-coarse:w-9" />
        <span className="ml-1 flex-1 text-[19px] font-semibold tracking-tight pointer-coarse:text-[22px]">Anemo</span>
        {onClose ? (
          // On a phone Notifications and Settings sit up here, so the chats get the room.
          <>
            <HeaderLink to="/notifications" label="Notifications" icon={<Bell />} badge={<NotificationsBadge />} />
            <HeaderLink to="/settings" label="Settings" icon={<Settings />} />
            <button type="button" aria-label="Close menu" onClick={onClose}
              className="flex h-10 w-10 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text">
              <X className="h-5 w-5" />
            </button>
          </>
        ) : (
          <button type="button" aria-label="Hide the sidebar" title="Hide the sidebar (Ctrl+\)" onClick={() => setCollapsed(true)}
            className="flex h-8 w-8 items-center justify-center rounded-control text-subtle hover:bg-surface-hover hover:text-text">
            <PanelLeftClose className="h-4 w-4" />
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
          title="Search everything (Ctrl+K)"
          // On a phone the search takes the screen, so the menu makes way for it.
          onClick={() => { onClose?.(); openSearch(true) }}>
          <Search className="h-4 w-4" />
        </Button>
      </div>

      {!onClose && <ProjectSwitcher />}

      {/* The chats take all the free height and are the only thing that scrolls. */}
      <div className="mt-1 flex min-h-52 flex-1 flex-col">
        <ConversationList beside={onClose && <ProjectSwitcher compact />} />
        <NavLink to="/chats"
          className={({ isActive }) =>
            cn('mt-1 flex h-9 shrink-0 items-center gap-2.5 rounded-control px-3 text-[13px] font-medium pointer-coarse:h-11 pointer-coarse:text-[15px]',
              isActive ? 'bg-accent-soft text-accent' : 'text-text hover:bg-surface-hover')}>
          <MessagesSquare className="h-4 w-4 text-accent" />
          <span className="flex-1">All chats</span>
          <ChevronRight className="h-3.5 w-3.5 text-subtle" />
        </NavLink>
      </div>

      {/* The pages, pinned: always in the same place, one tap away. */}
      <Divider className="mx-1 my-2" />
      {/* On a phone: three columns of small tiles, three rows instead of five. */}
      <nav aria-label="Pages" className={cn('grid shrink-0 gap-0.5', onClose ? 'grid-cols-3' : 'grid-cols-2')}>
        <Page to="/projects" icon={<FolderKanban />}>Projects</Page>
        <Page to="/files" icon={<FolderOpen />}>Files</Page>
        <Page to="/documents" icon={<FileText />}>Documents</Page>
        <Page to="/tasks" icon={<CheckSquare />}>Tasks</Page>
        <Page to="/calendar" icon={<CalendarDays />}>Calendar</Page>
        <Page to="/runs" icon={<History />} badge={<RunsBadge />}>Runs</Page>
        <Page to="/automations" icon={<Clock />}>Automations</Page>
        <Page to="/agents" icon={<Bot />} title="Profiles & Skills">Agents</Page>
        <Page to="/memory" icon={<Brain />} badge={<MemoryBadge />}>Memory</Page>
      </nav>

      {/* Sign out is under Settings > General too; on a phone this row would only take room. */}
      {!onClose && <Divider className="mx-1 my-2" />}
      {!onClose && <div className="grid shrink-0 grid-cols-2 gap-0.5">
        <div className="col-span-2">
          <PageLink to="/notifications" icon={<Bell />} badge={<NotificationsBadge />}>Notifications</PageLink>
        </div>
        <PageLink to="/settings" icon={<Settings />}>Settings</PageLink>
        <button type="button" onClick={() => logout.mutate()} title={me.data ? `Signed in as ${me.data.username}` : undefined}
          className="flex h-8 min-w-0 items-center gap-1.5 rounded-control px-2 text-[12.5px] font-medium text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10 pointer-coarse:text-[14px]">
          <LogOut className="h-4 w-4 shrink-0" />
          <span className="truncate">Sign out</span>
        </button>
      </div>}
    </aside>
  )
}
