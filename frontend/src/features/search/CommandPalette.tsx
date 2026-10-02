/**
 * The search box that opens with Ctrl+K (⌘K on a Mac) from anywhere: type to find
 * chats, documents, tasks and so on, or the name of a page to jump there.
 * Arrow keys move, Enter opens, Esc closes. Mounted once in AppLayout.
 *
 * It floats over the page like a spotlight: a large field in a raised, slightly
 * see-through panel. Before anything is typed it suggests three pages at a time and
 * moves on to the next three every few seconds.
 */
import { type KeyboardEvent, useEffect, useState } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { useNavigate } from 'react-router'
import { CornerDownLeft, type LucideIcon, Search, X } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { useSearch } from './api'
import { Highlighted } from './Highlighted'
import { kindInfo } from './kinds'
import { matchingPages } from './pages'
import { usePalette } from './paletteStore'

interface Item {
  key: string
  /** Shown above the first item of each section. */
  section: string
  icon: LucideIcon
  title: string
  detail?: string
  to: string
}

/** Suggested pages shown at once, and how long before the next ones take their place. */
const SUGGESTIONS = 3
const SUGGESTION_MS = 4000

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return debounced
}

export function CommandPalette() {
  const { open, setOpen } = usePalette()

  // Ctrl+K / ⌘K toggles it from anywhere.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(!usePalette.getState().open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])

  const [session, setSession] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setSession(session + 1)
  }

  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fade fixed inset-0 z-40 bg-black/45 backdrop-blur-sm" />
        <RadixDialog.Content aria-describedby={undefined}
          className={cn(
            'pop fixed inset-x-3 top-[max(3.5rem,calc(env(safe-area-inset-top)+1rem))] z-50 mx-auto flex max-h-[min(72dvh,560px)] max-w-xl flex-col overflow-hidden focus:outline-none md:top-[14vh]',
            // Raised and slightly see-through, with a hairline of light along the edge.
            'rounded-3xl border border-border-strong bg-card/85 shadow-[0_28px_90px_-18px_rgb(0_0_0/0.65)] ring-1 ring-white/5 backdrop-blur-2xl',
          )}>
          <RadixDialog.Title className="sr-only">Search</RadixDialog.Title>
          {/* Remounted each time it opens, so it starts empty (but not while it closes,
              or the results would vanish before the closing animation). */}
          <PaletteBody key={session} onDone={() => setOpen(false)} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

function PaletteBody({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const typed = query.trim()
  const results = useSearch(useDebounced(typed, 200), { limit: 4, mode: 'keyword' })

  // Nothing typed: suggested pages, three at a time, moving on every few seconds. It
  // waits while you point at them or move with the arrow keys, and people who asked
  // their system for less motion get the whole list instead.
  const pages = matchingPages(typed)
  const still = useMediaQuery('(prefers-reduced-motion: reduce)')
  const cycling = typed === '' && !still
  const rounds = Math.ceil(pages.length / SUGGESTIONS)
  const [round, setRound] = useState(0)
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!cycling || held) return
    const t = window.setInterval(() => setRound((r) => (r + 1) % rounds), SUGGESTION_MS)
    return () => window.clearInterval(t)
  }, [cycling, held, rounds])
  const shownPages = cycling ? pages.slice(round * SUGGESTIONS, (round + 1) * SUGGESTIONS) : pages.slice(0, typed ? 4 : 30)

  const items: Item[] = [
    ...shownPages.map((p) => ({ key: `page:${p.to}`, section: typed ? 'Go to' : 'Suggestions', icon: p.icon, title: p.label, to: p.to })),
    ...(typed ? (results.data?.groups ?? []) : []).flatMap((group) =>
      group.hits.map((hit) => ({
        key: `${hit.kind}:${hit.id}`,
        section: kindInfo(hit.kind).label,
        icon: kindInfo(hit.kind).icon,
        title: hit.title,
        detail: hit.snippet,
        to: hit.url,
      })),
    ),
    ...(typed
      ? [{ key: 'all', section: 'Search', icon: Search, title: `All results for “${typed}”`, to: `/search?q=${encodeURIComponent(typed)}` }]
      : []),
  ]
  const active = Math.min(selected, items.length - 1)

  const go = (item: Item) => {
    onDone()
    void navigate(item.to)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setHeld(true)
      const step = e.key === 'ArrowDown' ? 1 : -1
      setSelected((active + step + items.length) % items.length)
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault()
      go(items[active])
    }
  }

  return (
    <>
      <div className="flex items-center gap-3 px-4 md:px-5">
        <Search className="h-5 w-5 shrink-0 text-accent" />
        <input autoFocus value={query} placeholder="Search, or type a page name…" aria-label="Search"
          role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={items[active] ? `palette-${active}` : undefined}
          onChange={(e) => { setQuery(e.target.value); setSelected(0) }} onKeyDown={onKeyDown}
          className="h-14 min-w-0 flex-1 bg-transparent text-[17px] placeholder:text-subtle focus:outline-none md:h-[3.75rem] md:text-[18px]" />
        {results.isFetching && typed && <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />}
        {/* Clears what was typed; with nothing typed it closes the search (handy on a phone). */}
        <button type="button" aria-label={query ? 'Clear the search' : 'Close the search'} onClick={() => (query ? setQuery('') : onDone())}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted hover:bg-surface-hover hover:text-text md:hidden">
          <X className="h-4 w-4" />
        </button>
        <kbd className="hidden shrink-0 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] text-subtle md:block">esc</kbd>
      </div>
      <ul id="palette-list" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto border-t border-border p-2"
        onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}>
        {items.map((item, i) => (
          // Suggestions get a new key each round, so the next three rise into place.
          <li key={cycling ? `${round}:${item.key}` : item.key} role="presentation"
            className={cn(cycling && 'animate-[rise-in_320ms_var(--ease-out)_backwards]')} style={cycling ? { animationDelay: `${i * 50}ms` } : undefined}>
            {(i === 0 || items[i - 1].section !== item.section) && (
              <div className="flex items-center px-2.5 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-wider text-subtle">
                <span className="flex-1">{item.section}</span>
                {cycling && rounds > 1 && (
                  <span className="flex items-center gap-1" aria-hidden>
                    {Array.from({ length: rounds }, (_, n) => (
                      <span key={n} className={cn('h-1.5 rounded-full transition-all duration-300', n === round ? 'w-4 bg-accent' : 'w-1.5 bg-border-strong')} />
                    ))}
                  </span>
                )}
              </div>
            )}
            <button type="button" id={`palette-${i}`} role="option" aria-selected={i === active}
              // Scrolls the selected row into view when moving with the arrow keys.
              ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              onMouseMove={() => setSelected(i)} onClick={() => go(item)}
              className={cn('flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition-colors active:bg-surface-hover',
                i === active && 'bg-surface-hover shadow-soft')}>
              <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
                i === active ? 'bg-accent text-accent-contrast' : 'bg-accent-soft text-accent')}>
                <item.icon className="h-[18px] w-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14.5px] font-medium">{item.title}</span>
                {item.detail && <span className="block truncate text-[12.5px] text-muted"><Highlighted text={item.detail} /></span>}
              </span>
              {i === active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-subtle pointer-coarse:hidden" />}
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">Nothing found.</li>}
      </ul>
    </>
  )
}
