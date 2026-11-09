/** Find in the open chat: type, Enter for the next match, Shift+Enter for the one before, Esc to close. */
import { useEffect, useState, type RefObject } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { Input } from '../ui/Input'
import { clearMatches, findRanges, showMatches } from './find'

export function FindBar({ root, version, onClose }: { root: RefObject<HTMLElement | null>; version: number; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState({ count: 0, at: 0 })

  // Matches are looked up again when the query or the messages change.
  useEffect(() => {
    const ranges = root.current ? findRanges(root.current, query) : []
    showMatches(ranges, 0)
    const id = window.setTimeout(() => setFound({ count: ranges.length, at: 0 }), 0)
    return () => window.clearTimeout(id)
  }, [query, root, version])
  useEffect(() => clearMatches, [])

  const go = (by: 1 | -1) => {
    const ranges = root.current ? findRanges(root.current, query) : []
    if (!ranges.length) return
    const at = (found.at + by + ranges.length) % ranges.length
    showMatches(ranges, at)
    setFound({ count: ranges.length, at })
  }
  const button = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-text disabled:opacity-40'
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface px-2 py-1.5" role="search">
      <Input
        autoFocus
        aria-label="Find in this chat"
        placeholder="Find in this chat"
        value={query}
        className="h-8"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') go(e.shiftKey ? -1 : 1)
          if (e.key === 'Escape') onClose()
        }}
      />
      <span className="w-14 shrink-0 text-center text-[11.5px] tabular-nums text-muted" aria-live="polite" data-testid="find-count">
        {query.trim() ? (found.count ? `${found.at + 1} of ${found.count}` : 'None') : ''}
      </span>
      <button type="button" className={button} aria-label="Previous match" disabled={!found.count} onClick={() => go(-1)}>
        <ChevronUp className="h-4 w-4" />
      </button>
      <button type="button" className={button} aria-label="Next match" disabled={!found.count} onClick={() => go(1)}>
        <ChevronDown className="h-4 w-4" />
      </button>
      <button type="button" className={button} aria-label="Close find" onClick={onClose}>
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
