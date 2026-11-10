import { useEffect, useRef } from 'react'
import { Draggable } from '@fullcalendar/interaction'
import { GripVertical } from 'lucide-react'
import type { Task } from '@/features/tasks/api'

/**
 * In the column beside the calendar (wide screens): the open tasks that have no date yet. Dragging one
 * onto a day gives it that day; onto a time, that time too (CalendarPage handles the drop).
 */
export function UnscheduledTasks({ tasks, onOpen }: { tasks: Task[]; onOpen: (task: Task) => void }) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!list.current) return
    // FullCalendar's own drag source: the calendar reports where a row was dropped. No
    // event is made from the row itself: the task shows up once its date is saved.
    const draggable = new Draggable(list.current, { itemSelector: '[data-task-id]', eventData: () => ({ create: false }) })
    return () => draggable.destroy()
  }, [])
  return (
    <section aria-label="Tasks without a date" className="flex min-h-0 flex-1 flex-col rounded-card border border-border bg-card p-2 shadow-soft">
      <h2 className="px-2 pb-1 pt-1.5 text-[12px] font-semibold">No date yet</h2>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto">
        {tasks.map((t) => (
          <div key={t.id} data-task-id={t.id} title="Drag onto the calendar to give it a date"
            className="mb-1 flex h-9 cursor-grab items-center gap-1.5 rounded-control bg-surface-2 pl-1.5 pr-2 text-[13px] active:cursor-grabbing">
            <GripVertical aria-hidden className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <button type="button" onClick={() => onOpen(t)} className="min-w-0 flex-1 truncate text-left hover:text-accent">{t.title}</button>
          </div>
        ))}
        {tasks.length === 0 && <p className="px-2 py-1 text-[13px] text-muted">Every open task has a date.</p>}
      </div>
      <p className="px-2 pt-2 text-[12px] text-muted">Drag a task onto a day to give it a date.</p>
    </section>
  )
}
