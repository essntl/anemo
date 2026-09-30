import type { ReactNode } from 'react'
import { Link, Navigate, NavLink, Outlet, useMatch } from 'react-router'
import { ChevronLeft, ChevronRight, ShieldCheck } from 'lucide-react'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { SETTINGS_SECTIONS } from '../sections'

function SectionLink({ to, children, sensitive }: { to: string; children: ReactNode; sensitive?: boolean }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'flex h-9 items-center gap-2 rounded-control px-3 text-[13px] font-medium',
          'max-md:h-12 max-md:text-[15px]',
          isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-text',
        )
      }
    >
      <span className="flex-1">{children}</span>
      {sensitive && <ShieldCheck className="h-3.5 w-3.5 opacity-60" aria-label="Security-sensitive" />}
      <ChevronRight className="h-4 w-4 text-subtle md:hidden" />
    </NavLink>
  )
}

/** /settings itself: desktop jumps to the first section; phones show the section list. */
export function SettingsIndex() {
  const desktop = useMediaQuery(DESKTOP)
  return desktop ? <Navigate to="general" replace /> : null
}

/**
 * Desktop: section list on the left, the section on the right.
 * Phones: /settings is the list; each section is its own page with a back link.
 */
export function SettingsLayout() {
  const isIndex = useMatch('/settings') !== null
  return (
    <div className="mx-auto flex max-w-5xl gap-8 p-4 md:p-8">
      <div className={cn('w-full shrink-0 md:block md:w-52', !isIndex && 'hidden')}>
        <h1 className="mb-4 px-3 text-xl font-semibold">Settings</h1>
        <nav className="flex flex-col gap-0.5">
          {SETTINGS_SECTIONS.map((s) => (
            <SectionLink key={s.to} to={s.to} sensitive={s.sensitive}>
              {s.label}
            </SectionLink>
          ))}
        </nav>
      </div>
      <div className={cn('min-w-0 flex-1', isIndex && 'hidden md:block')}>
        <Link to="/settings" className="-ml-1 mb-3 inline-flex h-10 items-center gap-1 pr-2 text-[14px] text-muted hover:text-text md:hidden">
          <ChevronLeft className="h-4 w-4" /> Settings
        </Link>
        <Outlet />
      </div>
    </div>
  )
}
