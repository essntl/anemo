import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Reorder, useDragControls } from 'motion/react'
import { Check, ChevronLeft, ChevronRight, GripVertical, NotebookPen, X } from 'lucide-react'
import { useCurrentProject } from '@/app/projectStore'
import { useToday } from '@/hooks/useNow'
import { cn } from '@/lib/cn'
import { addNote, editNote, moveNote, type Note, type NoteChange, parseNotes, removeNote, reorderNotes, shiftDay, shortDay, toggleNote } from '../dailyNote'
import type { WidgetLayout } from '../layout'
import { dailyNoteKey, useDailyNote } from '../useDailyNote'
import { ROWS } from './rows'
import { QuickAdd, WidgetHeader } from './parts'

const ROW_PX = 36

/**
 * Daily note: today's important short notes, one line each. Enter adds one; they can
 * be ticked off, edited in place, dragged (or moved with the arrow keys on their grip)
 * and deleted. The arrows step through earlier days. Kept as the document
 * documents/daily/<date>.md (in a project's folder when a project is chosen).
 */
export function DailyNoteWidget({ item }: { item: WidgetLayout }) {
  const qc = useQueryClient()
  const project = useCurrentProject()
  const projectId = project?.id ?? null
  const [day, setDay] = useState<string>('today')
  const { note, content, ready, isError, error, apply } = useDailyNote(day, projectId)
  const notes = parseNotes(content)
  const today = note?.today
  const shownDay = note?.date
  const isToday = day === 'today' || (!!today && shownDay === today)

  // A new day (at midnight, or the next morning): "today" is another note.
  const localDay = useToday()
  const firstDay = useRef(localDay)
  useEffect(() => {
    if (localDay !== firstDay.current) {
      firstDay.current = localDay
      void qc.invalidateQueries({ queryKey: dailyNoteKey('today', projectId) })
    }
  }, [localDay, qc, projectId])

  const go = (by: number) => {
    if (!shownDay || !today) return
    const next = shiftDay(shownDay, by)
    setDay(next >= today ? 'today' : next)
  }

  const doc = note?.document
  const rows = ROWS[item.h] + (item.h === 1 ? 0 : 1)
  return (
    <>
      <WidgetHeader title="Daily note" icon={<NotebookPen />} to={doc ? `/documents/${doc.id}` : '/documents'} />
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-3">
        <div className="mb-1.5 flex items-center gap-1 px-2" role="group" aria-label="Day">
          <NavButton label="Previous day" disabled={!ready} onClick={() => go(-1)}><ChevronLeft className="h-4 w-4" /></NavButton>
          <span className="min-w-0 flex-1 truncate text-center text-[12.5px] font-medium text-muted" aria-live="polite" data-testid="daily-note-day">
            {!shownDay ? ' ' : isToday ? `Today, ${shortDay(shownDay)}` : shortDay(shownDay)}
          </span>
          {!isToday && (
            <button type="button" onClick={() => setDay('today')}
              className="h-7 rounded-full px-2.5 text-[12px] font-medium text-accent hover:bg-surface-hover pointer-coarse:h-9">
              Today
            </button>
          )}
          <NavButton label="Next day" disabled={!ready || isToday} onClick={() => go(1)}><ChevronRight className="h-4 w-4" /></NavButton>
        </div>
        <div className="px-2">
          <QuickAdd placeholder={isToday ? 'Add a note for today' : 'Add a note for this day'}
            onAdd={(text) => note && apply(addNote(text, note.heading))} busy={!ready} />
        </div>
        {isError && <p className="px-2 py-2 text-[13px] text-error">The note could not be loaded.</p>}
        {error && <p role="alert" className="px-2 py-1 text-[12.5px] text-error">Not saved: {error}</p>}
        {ready && notes.length === 0 && (
          <p className="px-2 py-3 text-center text-[13px] text-muted">
            {isToday ? 'Nothing noted yet. Jot down what must not slip today.' : 'No notes on this day.'}
          </p>
        )}
        {notes.length > 0 && <NoteList notes={notes} apply={apply} maxHeight={rows * ROW_PX} />}
      </div>
    </>
  )
}

function NavButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-text disabled:pointer-events-none disabled:opacity-40 pointer-coarse:h-9 pointer-coarse:w-9">
      {children}
    </button>
  )
}

function NoteList({ notes, apply, maxHeight }: { notes: Note[]; apply: (change: NoteChange) => void; maxHeight: number }) {
  // While dragging, the order shown; saved when the note is let go.
  const [order, setOrder] = useState<number[] | null>(null)
  const shown = order && order.length === notes.length ? order : notes.map((n) => n.index)
  const finishDrag = () => {
    if (order && order.some((n, i) => n !== i)) apply(reorderNotes(order))
    setOrder(null)
  }
  // Keys follow the note, not its position, so a moved note keeps its focus.
  const seen = new Map<string, number>()
  const keys = notes.map((n) => {
    const nth = (seen.get(n.text) ?? 0) + 1
    seen.set(n.text, nth)
    return `${n.text}#${nth}`
  })
  return (
    <Reorder.Group axis="y" values={shown} onReorder={setOrder} aria-label="Notes"
      className="flex flex-col overflow-y-auto overscroll-contain" style={{ maxHeight }}>
      {shown.map((index, position) => (
        <NoteRow key={keys[index]} note={notes[index]} position={position} count={notes.length}
          apply={apply} onDragEnd={finishDrag} />
      ))}
    </Reorder.Group>
  )
}

function NoteRow({ note, position, count, apply, onDragEnd }: {
  note: Note
  position: number
  count: number
  apply: (change: NoteChange) => void
  onDragEnd: () => void
}) {
  const controls = useDragControls()
  const [editing, setEditing] = useState(false)
  const cancelled = useRef(false)

  const commit = (text: string) => {
    setEditing(false)
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    const t = text.trim()
    if (!t) apply(removeNote(note.index))
    else if (t !== note.text) apply(editNote(note.index, t))
  }

  function onGripKey(e: KeyboardEvent) {
    const by = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
    if (!by) return
    e.preventDefault()
    const change = moveNote(note.index, by, count)
    if (change) apply(change)
  }

  return (
    <Reorder.Item value={note.index} dragListener={false} dragControls={controls} layout="position" onDragEnd={onDragEnd}
      data-testid="daily-note" className="group flex items-center gap-2 rounded-control bg-surface px-1 py-1 hover:bg-surface-hover">
      <button type="button" aria-label={`Move “${note.text}”`} title="Drag, or use the arrow keys, to move"
        aria-description={`Note ${position + 1} of ${count}. Up and down arrows move it.`}
        onPointerDown={(e) => controls.start(e)} onKeyDown={onGripKey}
        className="flex h-6 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-subtle opacity-0 hover:text-text focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <button type="button" role="checkbox" aria-checked={note.done} aria-label={note.done ? `Untick “${note.text}”` : `Tick off “${note.text}”`}
        onClick={() => apply(toggleNote(note.index, !note.done))}
        className={cn('flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border-2 transition-colors pointer-coarse:h-6 pointer-coarse:w-6',
          note.done ? 'border-success bg-success text-white' : 'border-border-strong hover:border-accent')}>
        {note.done && <Check className="h-3 w-3" strokeWidth={3} />}
      </button>
      {editing ? (
        <input autoFocus defaultValue={note.text} aria-label={`Edit “${note.text}”`} maxLength={500}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancelled.current = true
              e.currentTarget.blur()
            }
          }}
          className="h-7 min-w-0 flex-1 rounded bg-surface-2 px-1.5 text-[13.5px] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      ) : (
        <button type="button" onClick={() => {
          cancelled.current = false
          setEditing(true)
        }} title="Edit"
          className={cn('min-w-0 flex-1 truncate text-left text-[13.5px]', note.done && 'text-muted line-through')}>
          {note.text || <span className="text-subtle">Empty note</span>}
        </button>
      )}
      <button type="button" aria-label={`Delete “${note.text}”`} title="Delete" onClick={() => apply(removeNote(note.index))}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-subtle opacity-0 hover:bg-surface-2 hover:text-error focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
        <X className="h-3.5 w-3.5" />
      </button>
    </Reorder.Item>
  )
}
