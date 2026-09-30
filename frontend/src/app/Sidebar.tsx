import type { ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router'
import {
  Bot,
  Brain,
  CalendarDays,
  CheckSquare,
  Clock,
  FileText,
  FolderOpen,
  History,
  LogOut,
  Plus,
  Settings,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useLogout, useMe } from '@/features/auth/api'
import { ConversationList } from '@/features/chat/components/ConversationList'
import { cn } from '@/lib/cn'

function NavItem({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
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
      {children}
    </NavLink>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-5">
      <div className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">
        {label}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  )
}

/** `onClose` is set when the sidebar is shown in the phone drawer. */
export function Sidebar({ className, onClose }: { className?: string; onClose?: () => void }) {
  const navigate = useNavigate()
  const me = useMe()
  const logout = useLogout()
  return (
    <aside className={cn('h-full shrink-0 flex-col border-r border-border bg-surface px-3 py-4', onClose ? 'flex' : '', className)}>
      <div className="mb-4 flex items-center gap-2 px-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-accent-contrast">
          <Bot className="h-4.5 w-4.5" />
        </div>
        <span className="flex-1 text-[15px] font-semibold">anemo</span>
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
      </div>

      <nav className="mt-2 min-h-0 flex-1 overflow-y-auto">
        <ConversationList />
        <Section label="Workspace">
          <NavItem to="/files" icon={<FolderOpen />}>Files</NavItem>
          <NavItem to="/documents" icon={<FileText />}>Documents</NavItem>
          <NavItem to="/tasks" icon={<CheckSquare />}>Tasks</NavItem>
          <NavItem to="/calendar" icon={<CalendarDays />}>Calendar</NavItem>
        </Section>
        <Section label="Agents">
          <NavItem to="/runs" icon={<History />}>Runs</NavItem>
          <NavItem to="/automations" icon={<Clock />}>Automations</NavItem>
          <NavItem to="/agents" icon={<Bot />}>Profiles & Skills</NavItem>
        </Section>
        <Section label="You">
          <NavItem to="/memory" icon={<Brain />}>Memory</NavItem>
        </Section>
      </nav>

      <div className="flex flex-col gap-0.5 border-t border-border pt-3">
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
