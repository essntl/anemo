/**
 * A board: columns side by side, each with its cards. On a narrow screen the columns
 * scroll sideways, one at a time. What moving a card means (a new status, a new value
 * of a property) is up to the page: `onMove`.
 *
 * Moving a card:
 * - mouse: drag it; a finger: press and hold it for a moment, then drag (usePointerDrag);
 * - keyboard: focus it, Space picks it up, the arrow keys move it, Space puts it down
 *   and Esc puts it back. A live region tells screen readers where it is.
 *
 * Used by the task board (Tasks page, Home) and the board layout of saved views.
 */
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import { useShortcut } from '@/hooks/useShortcut'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { matchesShortcut, SHORTCUTS } from '@/features/shortcuts/registry'
import { orderAfterMove, type Slot, stepSlot } from './placement'
import { type DragStart, usePointerDrag } from './usePointerDrag'

export interface BoardColumn<T> {
  id: string
  label: string
  items: T[]
  /** false: the column sorts itself (e.g. Done, newest first): a card can be put in, not placed. */
  ordered?: boolean
  /** A "+" in the column's header, with this label for screen readers. */
  add?: { label: string; onAdd: () => void }
  /** Under the cards, e.g. a link to everything the column leaves out. */
  footer?: ReactNode
}

/** A card put somewhere: into column `to`, in front of card `before` (null: at the end). */
export interface BoardMove {
  id: string
  from: string
  to: string
  before: string | null
  /** The ids of column `to` as they are shown after the move. */
  order: string[]
}

interface BoardProps<T> {
  /** The board's name for screen readers. */
  label: string
  columns: BoardColumn<T>[]
  itemId: (item: T) => string
  /** The card's name in what screen readers are told ("Call the bank moved to Done"). */
  itemLabel: (item: T) => string
  renderCard: (item: T, column: BoardColumn<T>) => ReactNode
  /** A click (or Enter) on a card. Without it a card's own links and controls do that. */
  onOpen?: (item: T) => void
  onMove?: (move: BoardMove) => void
  /** Classes for each column's list of cards, e.g. a height after which it scrolls. */
  cardsClassName?: string
}

/** Where a card would land: a column, and the card it would go in front of (null: the end). */
type Target = { column: string; before: string | null }

const CARD = 'rounded-control border border-border bg-card px-3 py-(--list-row-y) shadow-soft'

export function Board<T>({ label, columns, itemId, itemLabel, renderCard, onOpen, onMove, cardsClassName }: BoardProps<T>) {
  const scroller = useRef<HTMLDivElement>(null)
  const ghost = useRef<HTMLDivElement>(null)
  const help = useId()
  // A card dragged with a pointer, and where it would land.
  const [lifted, setLifted] = useState<DragStart | null>(null)
  const [pointerTarget, setPointerTarget] = useState<Target | null>(null)
  // A card picked up with the keyboard, and the place the arrow keys have moved it to.
  const [picked, setPicked] = useState<{ id: string; from: string; slot: Slot } | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const ids = (column: BoardColumn<T>) => column.items.map(itemId)
  const ordered = (column: BoardColumn<T>) => column.ordered !== false
  const findItem = (id: string) => columns.flatMap((c) => c.items).find((item) => itemId(item) === id)

  /** The place a slot of the keyboard stands for, as a target. */
  const slotTarget = (id: string, slot: Slot): Target => {
    const column = columns[slot.column]
    return { column: column.id, before: ids(column).filter((x) => x !== id)[slot.index] ?? null }
  }
  const moving = lifted ? { id: lifted.id, from: lifted.column } : picked
  const target = lifted ? pointerTarget : picked ? slotTarget(picked.id, picked.slot) : null

  /** Carries out a move; false when the card would stay where it is. */
  function put(id: string, from: string, place: Target): boolean {
    const column = columns.find((c) => c.id === place.column)
    if (!column || !onMove) return false
    const before = ordered(column) ? place.before : null
    const order = orderAfterMove(ids(column), id, before)
    if (place.column === from && (!ordered(column) || order.join() === ids(column).join())) return false
    onMove({ id, from, to: place.column, before, order })
    return true
  }

  function where(place: Target, id: string): string {
    const column = columns.find((c) => c.id === place.column)
    if (!column) return ''
    if (!ordered(column)) return column.label
    const order = orderAfterMove(ids(column), id, place.before)
    return t('{column}, position {position} of {count}', { column: column.label, position: order.indexOf(id) + 1, count: order.length })
  }

  // ---- pointer ----
  const pointer = usePointerDrag(scroller, {
    onLift: (start) => {
      setPicked(null)
      setLifted(start)
      setPointerTarget({ column: start.column, before: null })
    },
    onMove: (x, y) => {
      if (ghost.current && lifted) ghost.current.style.transform = `translate(${x - lifted.offsetX}px, ${y - lifted.offsetY}px)`
      const next = pointTarget(x, y)
      setPointerTarget((old) => (old?.column === next?.column && old?.before === next?.before ? old : next))
    },
    onDrop: () => {
      if (lifted && pointerTarget) put(lifted.id, lifted.column, pointerTarget)
      setLifted(null)
      setPointerTarget(null)
    },
    onCancel: () => {
      setLifted(null)
      setPointerTarget(null)
    },
  })
  useShortcut('board.cancel', pointer.cancel, pointer.dragging)

  /** The column and place under the pointer: in front of the first card whose middle is below it. */
  function pointTarget(x: number, y: number): Target | null {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-board-column]')
    if (!el || !scroller.current?.contains(el)) return null
    const column = columns.find((c) => c.id === el.dataset.boardColumn)
    if (!column) return null
    if (!ordered(column)) return { column: column.id, before: null }
    const cards = [...el.querySelectorAll<HTMLElement>('[data-board-card]')].filter((c) => c.dataset.boardCard !== lifted?.id)
    const below = cards.find((c) => {
      const box = c.getBoundingClientRect()
      return box.top + box.height / 2 > y
    })
    return { column: column.id, before: below?.dataset.boardCard ?? null }
  }

  // ---- keyboard ----
  // After a move the card is a new element in another column: focus that one.
  const focusCard = (id: string) =>
    requestAnimationFrame(() => [...(scroller.current?.querySelectorAll<HTMLElement>('[data-board-card]') ?? [])].find((el) => el.dataset.boardCard === id)?.focus())

  function onCardKey(e: KeyboardEvent, item: T, columnIndex: number) {
    if (e.target !== e.currentTarget) return
    const id = itemId(item)
    const column = columns[columnIndex]
    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (!picked) {
      if (matchesShortcut(SHORTCUTS['board.open'], e) && onOpen) {
        handled()
        onOpen(item)
      } else if (matchesShortcut(SHORTCUTS['board.pickUp'], e) && onMove) {
        handled()
        const index = ids(column).indexOf(id)
        setPicked({ id, from: column.id, slot: { column: columnIndex, index } })
        setAnnouncement(t('Picked up {title}. The arrow keys move it, Space puts it down, Escape puts it back.', { title: itemLabel(item) }))
      }
      return
    }
    if (picked.id !== id) return
    if (matchesShortcut(SHORTCUTS['board.move'], e)) {
      handled()
      const sizes = columns.map((c) => ids(c).filter((x) => x !== id).length)
      const slot = stepSlot(picked.slot, e.key, sizes, columns.map(ordered))
      setPicked({ ...picked, slot })
      setAnnouncement(where(slotTarget(id, slot), id))
      // Keep the column it is going to in sight.
      scroller.current?.querySelectorAll<HTMLElement>('[data-board-column]')[slot.column]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    } else if (matchesShortcut(SHORTCUTS['board.pickUp'], e) || matchesShortcut(SHORTCUTS['board.open'], e)) {
      handled()
      const place = slotTarget(id, picked.slot)
      const moved = put(id, picked.from, place)
      setPicked(null)
      setAnnouncement(moved ? t('{title} moved to {place}.', { title: itemLabel(item), place: where(place, id) }) : t('{title} put down where it was.', { title: itemLabel(item) }))
      focusCard(id)
    } else if (matchesShortcut(SHORTCUTS['board.cancel'], e)) {
      handled()
      setPicked(null)
      setAnnouncement(t('{title} put back.', { title: itemLabel(item) }))
    }
  }

  const indicator = <span aria-hidden className="pointer-events-none absolute inset-x-1 -top-[5px] h-0.5 rounded-full bg-accent" />
  const liftedItem = lifted ? findItem(lifted.id) : undefined
  const liftedColumn = lifted ? columns.find((c) => c.id === lifted.column) : undefined

  return (
    <>
      <div ref={scroller} role="group" aria-label={label}
        className="-mx-1 flex snap-x snap-mandatory scroll-px-1 gap-3 overflow-x-auto overscroll-x-contain px-1 pb-2 md:snap-none">
        {columns.map((column, columnIndex) => {
          const isTarget = moving && target?.column === column.id
          const columnIds = ids(column)
          return (
            <section key={column.id} data-board-column={column.id} aria-label={column.label}
              className={cn('flex w-[min(18rem,82vw)] shrink-0 snap-start flex-col rounded-card border border-border bg-surface-2/50 p-2 transition-colors motion-reduce:transition-none md:w-72',
                isTarget && 'border-accent bg-accent-soft/40')}>
              <header className="flex items-center justify-between px-1.5 pb-2 pt-1 text-[12.5px] font-semibold text-muted">
                <span>{column.label} <span className="font-normal text-subtle tabular-nums">{column.items.length}</span></span>
                {column.add && (
                  <button type="button" aria-label={column.add.label} title={column.add.label} onClick={column.add.onAdd}
                    className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-surface-hover hover:text-text pointer-coarse:h-9 pointer-coarse:w-9">
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                )}
              </header>
              <div className={cn('flex min-h-16 flex-col gap-1.5 p-px', cardsClassName)}>
                {column.items.map((item) => {
                  const id = itemId(item)
                  const isPicked = picked?.id === id
                  return (
                    <div key={id} className="relative">
                      {isTarget && ordered(column) && target?.before === id && moving?.id !== id && indicator}
                      <div data-board-card={id} tabIndex={0}
                        role={onOpen ? 'button' : 'group'}
                        aria-roledescription={onMove ? t('movable card') : undefined}
                        aria-label={onOpen ? undefined : itemLabel(item)}
                        aria-describedby={onMove ? help : undefined}
                        onPointerDown={onMove ? (e) => pointer.onPointerDown(e, id, column.id) : undefined}
                        onClickCapture={pointer.onClickCapture}
                        onContextMenu={pointer.onContextMenu}
                        onDragStart={(e) => e.preventDefault()}
                        onClick={onOpen && (() => onOpen(item))}
                        onKeyDown={(e) => onCardKey(e, item, columnIndex)}
                        onBlur={() => isPicked && setPicked(null)}
                        className={cn(CARD, 'block w-full text-left outline-none transition-[border-color,box-shadow,opacity] hover:border-border-strong focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none',
                          onMove && 'select-none [-webkit-touch-callout:none]',
                          onOpen && 'cursor-pointer',
                          lifted?.id === id && 'opacity-40',
                          isPicked && 'border-accent shadow-float ring-2 ring-accent')}>
                        {renderCard(item, column)}
                      </div>
                    </div>
                  )
                })}
                {isTarget && ordered(column) && target?.before === null && columnIds.at(-1) !== moving?.id && (
                  <div className="relative h-1">{indicator}</div>
                )}
              </div>
              {column.footer}
            </section>
          )
        })}
      </div>
      {onMove && (
        <p id={help} className="sr-only">
          {t('Space picks the card up; then the arrow keys move it, Space puts it down and Escape puts it back.')}
        </p>
      )}
      <div aria-live="polite" aria-atomic className="sr-only">{announcement}</div>
      {lifted && liftedItem !== undefined && liftedColumn && createPortal(
        <div ref={ghost} aria-hidden className="pointer-events-none fixed left-0 top-0 z-50"
          style={{ width: lifted.rect.width, transform: `translate(${lifted.rect.left}px, ${lifted.rect.top}px)` }}>
          <div className={cn(CARD, 'rotate-1 cursor-grabbing shadow-float ring-1 ring-accent motion-reduce:rotate-0')}>
            {renderCard(liftedItem, liftedColumn)}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
