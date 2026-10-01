/**
 * Search results for everything in the workspace, grouped by kind. The query and
 * the chosen kind live in the URL (/search?q=otter&kind=task), so a result page
 * can be reloaded or linked. Documents and memories are also found by meaning
 * here when an embedding model is set up.
 */
import { type FormEvent, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Search, Sparkles } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/cn'
import { formatWhen } from '@/lib/format'
import { type SearchGroup, type SearchKind, useSearch } from './api'
import { Highlighted } from './Highlighted'
import { kindInfo, KINDS } from './kinds'

function Group({ group, onShowAll }: { group: SearchGroup; onShowAll?: () => void }) {
  const info = kindInfo(group.kind)
  return (
    <section>
      <h2 className="mb-1.5 flex items-center gap-2 px-1 text-[12px] font-semibold uppercase tracking-wider text-subtle">
        <info.icon className="h-3.5 w-3.5" /> {info.label}
      </h2>
      <div className="overflow-hidden rounded-card border border-border bg-card shadow-soft">
        {group.hits.map((hit) => (
          <Link key={hit.id} to={hit.url}
            className="flex items-start gap-3 border-t border-border px-4 py-2.5 first:border-t-0 hover:bg-surface-hover">
            <div className="min-w-0 flex-1">
              <div className="break-words text-[14px] font-medium">{hit.title}</div>
              {hit.snippet && (
                <div className="mt-0.5 line-clamp-2 break-words text-[12.5px] text-muted"><Highlighted text={hit.snippet} /></div>
              )}
            </div>
            {hit.when && <span className="shrink-0 pt-0.5 text-[12px] text-subtle">{formatWhen(hit.when)}</span>}
          </Link>
        ))}
      </div>
      {group.has_more && onShowAll && (
        <button type="button" onClick={onShowAll} className="mt-1.5 px-1 text-[13px] text-accent hover:underline">
          Show more {info.label.toLowerCase()}
        </button>
      )}
    </section>
  )
}

export function SearchPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const kind = KINDS.find((k) => k.kind === params.get('kind'))?.kind ?? null
  const [typed, setTyped] = useState(q)
  // When the query in the URL changes (e.g. a new search from Ctrl+K), show it in the box.
  const [shownQuery, setShownQuery] = useState(q)
  if (shownQuery !== q) {
    setShownQuery(q)
    setTyped(q)
  }
  // One kind: a long list of it. Everything: the best few of each.
  const results = useSearch(q, { kinds: kind ? [kind] : undefined, limit: kind ? 50 : 6, mode: 'hybrid' })
  const groups = results.data?.groups ?? []

  const show = (next: { q?: string; kind?: SearchKind | null }) => {
    const query = next.q ?? q
    const chosen = next.kind === undefined ? kind : next.kind
    setParams({ ...(query ? { q: query } : {}), ...(chosen ? { kind: chosen } : {}) }, { replace: next.q === undefined })
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    show({ q: typed.trim() })
  }

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <form onSubmit={submit} className="relative mb-3">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
        <input autoFocus={!q} value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Search"
          placeholder="Search chats, documents, tasks, files…"
          className="h-11 w-full rounded-control border border-border bg-surface pl-10 pr-3 text-[15px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft" />
      </form>

      <div className="mb-4 flex flex-wrap gap-1" role="tablist" aria-label="Kind of result">
        {[{ kind: null, label: 'Everything' }, ...KINDS].map((k) => (
          <button key={k.label} type="button" role="tab" aria-selected={kind === k.kind} onClick={() => show({ kind: k.kind })}
            className={cn('h-8 rounded-full px-3 text-[13px] font-medium transition-colors pointer-coarse:h-10',
              kind === k.kind ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-text')}>
            {k.label}
          </button>
        ))}
      </div>

      {results.isError && <p className="text-[13px] text-error">{errorMessage(results.error)}</p>}
      {!q && (
        <EmptyState icon={<Search className="h-5 w-5" />} title="Search your workspace"
          description="Chats, documents, memories, tasks, calendar events, files and automations. Press Ctrl+K anywhere for a quick search." />
      )}
      {q && results.isSuccess && groups.length === 0 && (
        <EmptyState icon={<Search className="h-5 w-5" />} title={`Nothing found for “${q}”`}
          description={kind ? 'Try “Everything”, or fewer words: every word has to match.' : 'Try fewer or different words: every word has to match.'} />
      )}
      <div className={cn('flex flex-col gap-5', results.isPlaceholderData && 'opacity-60')}>
        {groups.map((group) => (
          <Group key={group.kind} group={group} onShowAll={kind ? undefined : () => show({ kind: group.kind })} />
        ))}
      </div>
      {results.data?.by_meaning && groups.length > 0 && (
        <p className="mt-4 flex items-center gap-1.5 text-[12px] text-muted">
          <Sparkles className="h-3.5 w-3.5" /> Documents and memories were also searched by meaning, not only by these words.
        </p>
      )}
    </div>
  )
}
