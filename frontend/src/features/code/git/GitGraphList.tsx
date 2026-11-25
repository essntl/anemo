/**
 * The commits of the Git view, one row each: the graph, the refs, the subject, the author,
 * when, and the short hash. Only the rows in sight are in the page (fixed-height rows,
 * windowed), so a thousand commits scroll smoothly. The row height follows the density
 * setting (Settings → Appearance).
 *
 * A listbox: ↑/↓ (and Page Up/Down, Home/End) move the selection, Enter opens the
 * commit, Escape closes it.
 */
import { type KeyboardEvent, type Ref, memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from '@/components/ui/toast'
import { REDUCED_MOTION } from '@/features/appearance/motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { formatAgo, formatDateTime } from '@/lib/format'
import { plural, t } from '@/lib/i18n'
import type { GitCommit } from './gitApi'
import { graphWidth, initials, laneColor, nameColor, shortHash } from './gitFormat'
import type { LaneLayout } from './gitLanes'
import type { RefPill } from './gitRefs'
import { GraphCell } from './GraphCell'
import { useRowHeight } from './useRowHeight'
import { RefPills } from './RefPills'

/** Rows kept in the page above and below the ones in sight. */
const OVERSCAN = 12
/** The column headings over the rows (they stay at the top while it scrolls). */
const HEADER = 28

export interface GitGraphListHandle {
  /** Brings the row into sight (in the middle when it is far). */
  scrollToIndex: (index: number) => void
  focus: () => void
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const color = laneColor(nameColor(name))
  return (
    <span aria-hidden="true" title={name}
      className={cn('inline-flex h-5 w-5 shrink-0 select-none items-center justify-center rounded-full text-[9px] font-semibold tracking-tight', className)}
      style={{ backgroundColor: `color-mix(in oklch, ${color} 22%, var(--surface))`, color: `color-mix(in oklch, ${color}, var(--text) 45%)` }}>
      {initials(name)}
    </span>
  )
}

async function copyHash(hash: string) {
  try {
    await navigator.clipboard.writeText(hash)
    toast({ message: t('Copied {hash}', { hash: shortHash(hash) }) })
  } catch {
    toast({ message: t('Couldn’t copy to the clipboard') })
  }
}

const Row = memo(function Row({ commit, index, top, height, width, layout, pills, selected, flashing, head, remoteRepo, rowId, onPick }: {
  commit: GitCommit
  index: number
  top: number
  height: number
  width: number
  layout: LaneLayout
  pills: readonly RefPill[]
  selected: boolean
  flashing: boolean
  head: boolean
  remoteRepo: boolean
  rowId: string
  onPick: (index: number) => void
}) {
  const row = layout.rows[index]
  const merge = commit.parents.length > 1
  return (
    <div id={rowId} role="option" aria-selected={selected} data-hash={commit.hash}
      onClick={() => onPick(index)}
      className={cn('absolute inset-x-0 flex cursor-pointer items-center gap-2 pr-3 text-[13px]',
        selected ? 'bg-accent-soft group-focus-visible/list:shadow-[inset_2px_0_0_var(--accent)]' : 'hover:bg-surface-hover',
        flashing && 'flash')}
      style={{ top, height }}>
      <GraphCell row={row} width={width} height={height} head={head} />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <RefPills pills={pills} color={row.color} remoteRepo={remoteRepo} />
        <span className={cn('min-w-0 truncate', merge ? 'text-muted' : 'text-text', head && 'font-medium')} title={commit.subject}>
          {commit.subject || t('(no message)')}
        </span>
      </span>
      <span className="hidden w-36 min-w-0 shrink-0 items-center gap-1.5 text-[12px] text-muted @2xl:flex">
        <Avatar name={commit.authorName} />
        <span className="truncate">{commit.authorName}</span>
      </span>
      <Avatar name={commit.authorName} className="@2xl:hidden @max-sm:hidden" />
      <time dateTime={commit.date} title={formatDateTime(commit.date)}
        className="hidden w-[5.5rem] shrink-0 truncate text-right text-[12px] tabular-nums text-muted @md:block">
        {formatAgo(commit.date)}
      </time>
      <button type="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); void copyHash(commit.hash) }}
        title={t('Copy the full hash')} aria-label={t('Copy {hash}', { hash: shortHash(commit.hash) })}
        className="w-14 shrink-0 rounded-md px-1 py-0.5 text-left font-mono text-[11.5px] text-subtle hover:bg-surface-2 hover:text-text">
        {shortHash(commit.hash)}
      </button>
    </div>
  )
})

export function GitGraphList({ ref, commits, layout, pills, selected, flash, headCommit, remoteRepo, truncated, limit, maxLimit, loadingMore, onSelect, onOpen, onClose, onLoadMore, label }: {
  ref?: Ref<GitGraphListHandle>
  commits: readonly GitCommit[]
  layout: LaneLayout
  /** The pills of each commit, by hash (only commits with refs). */
  pills: ReadonlyMap<string, RefPill[]>
  selected: string | null
  /** A commit just jumped to: highlighted for a moment. */
  flash: string | null
  headCommit: string | null
  remoteRepo: boolean
  truncated: boolean
  limit: number
  maxLimit: number
  loadingMore: boolean
  onSelect: (hash: string) => void
  onOpen: (hash: string) => void
  onClose: () => void
  onLoadMore: () => void
  label: string
}) {
  const listId = useId()
  const height = useRowHeight()
  const still = useMediaQuery(REDUCED_MOTION)
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const width = graphWidth(layout.lanes)
  const index = useMemo(() => new Map(commits.map((c, i) => [c.hash, i])), [commits])
  const selectedIndex = selected ? index.get(selected) ?? -1 : -1

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    setViewport(el.clientHeight)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setViewport(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const scrollToIndex = useCallback((i: number) => {
    const el = scroller.current
    if (!el || i < 0) return
    const rowTop = HEADER + i * height
    const view = el.clientHeight || viewport
    // What is in sight under the headings.
    const from = el.scrollTop + HEADER
    if (rowTop >= from && rowTop + height <= el.scrollTop + view) return
    const near = rowTop >= from - height * 3 && rowTop <= el.scrollTop + view + height * 3
    // Next to what is in sight: just far enough to show it; further: in the middle.
    const to = near ? (rowTop < from ? rowTop - HEADER : rowTop + height - view) : rowTop - view / 2 + height / 2
    el.scrollTo({ top: Math.max(0, to), behavior: near || still ? 'auto' : 'smooth' })
  }, [height, viewport, still])

  useImperativeHandle(ref, () => ({ scrollToIndex, focus: () => scroller.current?.focus({ preventScroll: true }) }), [scrollToIndex])

  // The selection moved (by a key, a parent link, a branch): keep it in sight.
  useEffect(() => {
    if (selectedIndex >= 0) scrollToIndex(selectedIndex)
  }, [selectedIndex, scrollToIndex])

  const pick = useCallback((i: number) => {
    const hash = commits[i]?.hash
    if (!hash) return
    onSelect(hash)
    onOpen(hash)
  }, [commits, onSelect, onOpen])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor((viewport || 600) / height) - 1)
    const moves: Record<string, number> = {
      ArrowDown: selectedIndex + 1, ArrowUp: selectedIndex < 0 ? 0 : selectedIndex - 1,
      PageDown: selectedIndex + page, PageUp: selectedIndex - page, Home: 0, End: commits.length - 1,
    }
    if (e.key in moves) {
      e.preventDefault()
      const to = Math.min(commits.length - 1, Math.max(0, moves[e.key]))
      if (commits[to]) onSelect(commits[to].hash)
    } else if (e.key === 'Enter' && selected) {
      e.preventDefault()
      onOpen(selected)
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  const footer = truncated ? 1 : 0
  const total = (commits.length + footer) * height
  const shown = viewport || 800
  const first = Math.max(0, Math.floor((scrollTop - HEADER) / height) - OVERSCAN)
  const last = Math.min(commits.length, Math.ceil((scrollTop + shown) / height) + OVERSCAN)

  return (
    <div ref={scroller} role="listbox" tabIndex={0} aria-label={label}
      aria-activedescendant={selected && selectedIndex >= 0 ? `${listId}-${selectedIndex}` : undefined}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} onKeyDown={onKeyDown}
      className={cn('group/list @container relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain focus:outline-none',
        selectedIndex < 0 && 'focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]')}>
      <div aria-hidden="true" className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-surface/95 pr-3 text-[10.5px] font-semibold uppercase tracking-wider text-subtle backdrop-blur-sm" style={{ height: HEADER }}>
        <span className="shrink-0 pl-2.5" style={{ width }}>{t('Graph')}</span>
        <span className="min-w-0 flex-1 truncate">{t('Description')}</span>
        <span className="hidden w-36 shrink-0 @2xl:block">{t('Author')}</span>
        <span className="w-5 shrink-0 @2xl:hidden @max-sm:hidden" />
        <span className="hidden w-[5.5rem] shrink-0 text-right @md:block">{t('Date')}</span>
        <span className="w-14 shrink-0 pl-1">{t('Commit')}</span>
      </div>
      <div className="relative" style={{ height: total }}>
        {commits.slice(first, last).map((commit, i) => {
          const at = first + i
          return (
            <Row key={commit.hash} commit={commit} index={at} top={at * height} height={height} width={width} layout={layout}
              pills={pills.get(commit.hash) ?? NO_PILLS} selected={at === selectedIndex} flashing={!still && flash === commit.hash}
              head={commit.hash === headCommit} remoteRepo={remoteRepo} rowId={`${listId}-${at}`} onPick={pick} />
          )
        })}
        {footer > 0 && (
          <div className="absolute inset-x-0 flex items-center justify-center gap-2 text-[12.5px] text-muted" style={{ top: commits.length * height, height }}>
            {truncated && limit < maxLimit ? (
              <button type="button" onClick={onLoadMore} disabled={loadingMore}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 font-medium text-text shadow-soft hover:bg-surface-hover disabled:opacity-60">
                {loadingMore && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
                {loadingMore ? t('Loading more commits…') : t('Load more commits')}
              </button>
            ) : (
              <span>{plural(commits.length, 'Only the newest commit is loaded', 'Only the newest {n} commits are loaded')}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const NO_PILLS: RefPill[] = []
