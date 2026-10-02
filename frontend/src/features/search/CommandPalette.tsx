/**
 * The search box that opens with Ctrl+K (⌘K on a Mac) from anywhere: type to find
 * chats, documents, tasks and so on, or the name of a page to jump there.
 * Arrow keys move, Enter opens, Esc closes. Mounted once in AppLayout.
 */
import { type KeyboardEvent, useEffect, useState } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { useNavigate } from 'react-router'
import { ArrowRight, CornerDownLeft, type LucideIcon, Search } from 'lucide-react'
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
        <RadixDialog.Overlay className="fade fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" />
        <RadixDialog.Content aria-describedby={undefined}
          className="pop fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-50 mx-auto flex max-h-[min(80dvh,560px)] max-w-xl flex-col overflow-hidden rounded-panel border border-border bg-card shadow-float focus:outline-none md:top-[12vh]">
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

  const items: Item[] = [
    ...matchingPages(typed)
      .slice(0, typed ? 4 : 30)
      .map((p) => ({ key: `page:${p.to}`, section: 'Go to', icon: ArrowRight, title: p.label, to: p.to })),
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
      const step = e.key === 'ArrowDown' ? 1 : -1
      setSelected((active + step + items.length) % items.length)
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault()
      go(items[active])
    }
  }

  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-border px-4">
        <Search className="h-4 w-4 shrink-0 text-subtle" />
        <input autoFocus value={query} placeholder="Search everything, or type a page name…" aria-label="Search"
          role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={items[active] ? `palette-${active}` : undefined}
          onChange={(e) => { setQuery(e.target.value); setSelected(0) }} onKeyDown={onKeyDown}
          className="h-12 min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-subtle focus:outline-none" />
        {results.isFetching && typed && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />}
      </div>
      <ul id="palette-list" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {items.map((item, i) => (
          <li key={item.key} role="presentation">
            {(i === 0 || items[i - 1].section !== item.section) && (
              <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-subtle">{item.section}</div>
            )}
            <button type="button" id={`palette-${i}`} role="option" aria-selected={i === active}
              // Scrolls the selected row into view when moving with the arrow keys.
              ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              onMouseMove={() => setSelected(i)} onClick={() => go(item)}
              className={cn('flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left pointer-coarse:py-3',
                i === active && 'bg-surface-hover')}>
              <item.icon className="h-4 w-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium">{item.title}</span>
                {item.detail && <span className="block truncate text-[12px] text-muted"><Highlighted text={item.detail} /></span>}
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
