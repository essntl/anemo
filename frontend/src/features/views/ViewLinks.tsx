/**
 * The views in the sidebar: every view of the project shown (or the global ones when
 * no project is), pinned ones first. A document shows in every view it matches;
 * unpinning only moves a view down, it never hides it.
 */
import { NavLink } from 'react-router'
import { Pin, Rows3 } from 'lucide-react'
import { useScope } from '@/app/projectStore'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { useViews } from './api'
import { viewsOf } from './query'

export function ViewLinks({ onNavigate }: { onNavigate?: () => void }) {
  const views = useViews()
  const scope = useScope()
  const shown = viewsOf(views.data ?? [], scope.kind === 'project' ? scope.project.id : null)
  if (shown.length === 0) return null
  return (
    <nav aria-label={t('Views')} className="mt-1 flex shrink-0 flex-col gap-0.5">
      {shown.map((v) => (
        <NavLink key={v.id} to={`/views/${v.id}`} onClick={onNavigate}
          className={({ isActive }) =>
            cn('flex h-8 min-w-0 items-center gap-2.5 rounded-control px-2.5 text-[13px] font-medium transition-colors pointer-coarse:h-10',
              isActive ? 'bg-surface-2 font-semibold text-text [&>svg]:text-accent' : 'text-text hover:bg-surface-hover [&>svg]:text-muted')}>
          <Rows3 className="h-[17px] w-[17px] shrink-0" />
          <span className="min-w-0 flex-1 truncate">{v.name}</span>
          {v.pinned && <Pin aria-label={t('Pinned')} className="h-3 w-3 shrink-0" />}
        </NavLink>
      ))}
    </nav>
  )
}
