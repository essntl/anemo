import { PageHeader } from '@/components/ui/PageHeader'
import type { ReactNode } from 'react'
import { Link, Navigate, NavLink, Outlet, useMatch } from 'react-router'
import { ChevronLeft, ChevronRight, ShieldCheck } from 'lucide-react'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { useOffPages } from '../navigation'
import { visibleSections } from '../sections'
import { t } from '@/lib/i18n'

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
      {sensitive && <ShieldCheck className="h-3.5 w-3.5 opacity-60" aria-label={t('Security-sensitive')} />}
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
  const desktop = useMediaQuery(DESKTOP)
  const sections = visibleSections(useOffPages())
  const section = useMatch('/settings/:section')?.params.section
  const current = sections.find((s) => s.to === section)
  // A phone shows one section at a time: its name is the title, with the way back before it.
  const phoneSection = !desktop && !isIndex && current
  return (
    <div className="mx-auto flex max-w-5xl gap-8 p-4 md:px-8 md:pb-8 md:pt-2">
      {phoneSection ? (
        <PageHeader title={t(current.label)}
          before={
            <Link to="/settings" aria-label={t('Back to Settings')}
              className="-ml-2 flex h-10 w-8 items-center justify-center rounded-control text-muted hover:text-text">
              <ChevronLeft className="h-5 w-5" />
            </Link>
          } />
      ) : (
        <PageHeader title={t('Settings')} />
      )}
      <div className={cn('w-full shrink-0 md:block md:w-52', !isIndex && 'hidden')}>
        <nav className="flex flex-col gap-0.5">
          {sections.map((s) => (
            <SectionLink key={s.to} to={s.to} sensitive={s.sensitive}>
              {t(s.label)}
            </SectionLink>
          ))}
        </nav>
      </div>
      <div className={cn('min-w-0 flex-1', isIndex && 'hidden md:block')}>
        <Outlet />
      </div>
    </div>
  )
}
