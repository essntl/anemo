/**
 * A board: columns side by side (stacked on a phone), each with its cards. Drag a card
 * to another column, or to another place in its column, with the mouse. What a move
 * means (a new status, a new value of a property) is up to the page: `onMove`.
 *
 * Used by the task board (Tasks page, Home) and the board layout of saved views.
 */
import { type ReactNode, useState } from 'react'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { orderAfterMove } from './placement'

export interface BoardColumn<T> {
  id: string
  label: string
  items: T[]
  /** A "+" in the column's header, with this label for screen readers. */
  add?: { label: string; onAdd: () => void }
}

/** A card dropped somewhere: into column `to`, in front of card `before` (null: at the end). */
export interface BoardMove {
  id: string
  from: string
  to: string
  before: string | null
  /** The ids of column `to` as they would be shown after the move. */
  order: string[]
}

interface BoardProps<T> {
  columns: BoardColumn<T>[]
  itemId: (item: T) => string
  renderCard: (item: T, column: BoardColumn<T>) => ReactNode
  onOpen?: (item: T) => void
  onMove?: (move: BoardMove) => void
}

/** Where a card would land: a column, and the card it would go in front of (null: the end). */
type Target = { column: string; before: string | null }

export function Board<T>({ columns, itemId, renderCard, onOpen, onMove }: BoardProps<T>) {
  const [dragged, setDragged] = useState<{ id: string; from: string } | null>(null)
  const [target, setTarget] = useState<Target | null>(null)

  const drop = () => {
    const [card, place] = [dragged, target]
    setDragged(null)
    setTarget(null)
    if (!card || !place || !onMove) return
    const column = columns.find((c) => c.id === place.column)
    if (!column) return
    const order = orderAfterMove(column.items.map(itemId), card.id, place.before)
    onMove({ id: card.id, from: card.from, to: place.column, before: place.before, order })
  }

  return (
    <div className="flex flex-col gap-3 md:flex-row md:overflow-x-auto md:pb-2">
      {columns.map((column) => {
        const isTarget = target?.column === column.id
        return (
          <section key={column.id} aria-label={column.label}
            onDragOver={(e) => {
              e.preventDefault()
              if (target?.column !== column.id) setTarget({ column: column.id, before: null })
            }}
            onDrop={drop}
            className={cn('flex flex-col rounded-card md:w-72 md:shrink-0 border border-border bg-surface-2/50 p-2 transition-colors',
              isTarget && dragged && 'border-accent bg-accent-soft/40')}>
            <header className="flex items-center justify-between px-1.5 pb-2 pt-1 text-[12.5px] font-semibold text-muted">
              <span>{column.label} <span className="font-normal text-subtle">{column.items.length}</span></span>
              {column.add && (
                <button type="button" aria-label={column.add.label} onClick={column.add.onAdd}
                  className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-surface-hover hover:text-text pointer-coarse:h-9 pointer-coarse:w-9">
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
            </header>
            <div className="flex min-h-12 flex-col gap-1.5 md:min-h-16">
              {column.items.map((item) => {
                const id = itemId(item)
                return (
                  <div key={id} draggable={!!onMove}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      setDragged({ id, from: column.id })
                    }}
                    onDragEnd={() => { setDragged(null); setTarget(null) }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      if (target?.before !== id) setTarget({ column: column.id, before: id })
                    }}
                    onClick={onOpen && (() => onOpen(item))}
                    className={cn('cursor-pointer rounded-control border border-border bg-card px-3 py-2 shadow-soft hover:border-border-strong',
                      dragged?.id === id && 'opacity-40',
                      dragged && target?.before === id && 'border-t-2 border-t-accent')}>
                    {renderCard(item, column)}
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
