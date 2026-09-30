import type { ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router'
import { ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/cn'
import { SETTINGS_SECTIONS } from '../sections'

function Link({ to, children, sensitive }: { to: string; children: ReactNode; sensitive?: boolean }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'flex h-9 items-center justify-between rounded-control px-3 text-[13px] font-medium',
          isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-text',
        )
      }
    >
      {children}
      {sensitive && <ShieldCheck className="h-3.5 w-3.5 opacity-60" aria-label="Security-sensitive" />}
    </NavLink>
  )
}

export function SettingsLayout() {
  return (
    <div className="mx-auto flex max-w-5xl gap-8 p-8">
      <div className="w-52 shrink-0">
        <h1 className="mb-4 px-3 text-xl font-semibold">Settings</h1>
        <nav className="flex flex-col gap-0.5">
          {SETTINGS_SECTIONS.map((s) => (
            <Link key={s.to} to={s.to} sensitive={s.sensitive}>
              {s.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}
