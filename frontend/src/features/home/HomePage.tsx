/**
 * Home: a greeting and a grid of widgets (focus, music, today, tasks, …). The layout
 * is the same on every device (stored on the server); "Edit layout" (or E) lets you
 * move, resize, hide and add widgets. Every widget follows the project switcher.
 */
import { useNow } from '@/hooks/useNow'
import { Check, LayoutGrid, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useHotkey } from '@/hooks/useHotkey'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { moveWidget, patchWidget, resetLayout, resizeWidget, type WidgetLayout } from './layout'
import { useHomeLayout } from './useHomeLayout'
import { useNeedsYou } from './useNeedsYou'
import { type GridActions, WidgetGrid } from './WidgetGrid'
import { AskWidget } from './widgets/AskWidget'
import { BriefingWidget } from './widgets/BriefingWidget'
import { DocumentsWidget } from './widgets/DocumentsWidget'
import { FocusWidget } from './widgets/FocusWidget'
import { MusicWidget } from './widgets/MusicWidget'
import { NeedsYouWidget } from './widgets/NeedsYouWidget'
import { TasksWidget } from './widgets/TasksWidget'
import { TodayWidget } from './widgets/TodayWidget'
import { UpcomingWidget } from './widgets/UpcomingWidget'
import { WeekWidget } from './widgets/WeekWidget'

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function HomePage() {
  const { layout, update, ready } = useHomeLayout()
  const needs = useNeedsYou()
  const [editing, setEditing] = useState(false)
  // "Edit home layout" from the search box opens /home?edit=1.
  const [params, setParams] = useSearchParams()
  const editParam = params.get('edit') === '1'
  if (editParam && !editing) setEditing(true)
  useEffect(() => {
    if (editParam) setParams({}, { replace: true })
  }, [editParam, setParams])
  useHotkey((e) => e.key.toLowerCase() === 'e', () => setEditing((x) => !x))
  useHotkey((e) => e.key === 'Escape', () => setEditing(false), editing)
  const now = new Date(useNow())

  const actions: GridActions = {
    move: (id, to) => update((l) => moveWidget(l, id, to)),
    resize: (id, w, h) => update((l) => resizeWidget(l, id, w, h)),
    setHidden: (id, hidden) => update((l) => patchWidget(l, id, { hidden })),
  }

  function render(item: WidgetLayout) {
    switch (item.id) {
      case 'focus': return <FocusWidget item={item} />
      case 'music': return <MusicWidget item={item} />
      case 'today': return <TodayWidget item={item} />
      case 'tasks': return <TasksWidget item={item} />
      case 'week': return <WeekWidget item={item} />
      case 'documents': return <DocumentsWidget item={item} />
      case 'ask': return <AskWidget />
      case 'upcoming': return <UpcomingWidget item={item} />
      case 'needs': return <NeedsYouWidget item={item} onPin={(pinned) => update((l) => patchWidget(l, 'needs', { pinned }))} />
      case 'briefing':
        return <BriefingWidget item={item} onChoose={(id) => update((l) => patchWidget(l, 'briefing', { options: { ...item.options, automation_id: id } }))} />
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8 md:pt-14">
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight md:text-[28px]">
            {greeting(now.getHours())}<span className="text-accent">.</span>
          </h1>
          <p className="text-[14px] text-muted">{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        </div>
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => update(() => resetLayout())}>Reset layout</Button>
            <Button size="sm" variant="primary" icon={<Check className="h-4 w-4" />} onClick={() => setEditing(false)}>Done</Button>
          </div>
        ) : (
          <Button size="icon" variant="ghost" aria-label="Edit layout" title="Edit layout (E)" onClick={() => setEditing(true)}>
            <LayoutGrid className="h-4 w-4" />
          </Button>
        )}
      </div>

      {editing && (
        <p className="mb-3 text-[13px] text-muted">
          Drag a widget to move it and its corner to resize it. With the keyboard, focus a widget and use the arrow keys to move it, Shift and the arrows to resize it.
        </p>
      )}

      {ready && (
        <WidgetGrid layout={layout} editing={editing} actions={actions} render={render}
          shown={(item) => item.id !== 'needs' || !!item.pinned || (needs.ready && needs.rows.length > 0)} />
      )}
    </div>
  )
}
