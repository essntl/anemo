import { FileText, Globe, PlaySquare, RefreshCw, TextSelect, X } from 'lucide-react'
import { failureMessage } from '@/shared/pageFailure'
import type { PageContext, ReadFailure } from '@/shared/pageContext'
import { Notice } from '../ui/Notice'
import { AlwaysAllow } from '../sites/AlwaysAllow'

export type PageState =
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'ready'; page: PageContext }
  | { status: 'error'; failure: ReadFailure }

const ICONS = { page: Globe, selection: TextSelect, pdf: FileText, youtube: PlaySquare } as const

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The page that will go with the message: title, site, size. Shown before sending. */
export function PagePreview({ state, onRefresh, onRemove }: { state: PageState; onRefresh: () => void; onRemove: () => void }) {
  if (state.status === 'off') return null
  if (state.status === 'loading') {
    return <div className="mb-2 rounded-control border border-border bg-bg px-3 py-2 text-[12px] text-muted">Reading the page…</div>
  }
  if (state.status === 'error') {
    const text = failureMessage(state.failure)
    return (
      <div className="mb-2">
        <Notice tone="warning" title={text.title} actions={<button type="button" className="text-[12px] text-accent hover:underline" onClick={onRemove}>Don’t include a page</button>}>
          {text.body}
        </Notice>
      </div>
    )
  }
  const { page } = state
  const Icon = ICONS[page.source]
  return (
    <div className="mb-2 flex items-center gap-2 rounded-control border border-border bg-bg px-2.5 py-2" data-testid="page-chip" title={page.url}>
      <Icon className="h-4 w-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium">{page.title || host(page.url)}</div>
        <div className="truncate text-[11.5px] text-muted">
          {host(page.url)} · {page.wordCount.toLocaleString()} words
          {page.source === 'selection' ? ' · selection' : page.source === 'pdf' ? ' · PDF' : ''}
          {page.truncated ? ' · shortened (middle left out)' : ''}
        </div>
        <AlwaysAllow url={page.url} />
      </div>
      <button type="button" aria-label="Read the page again" title="Read the page again" onClick={onRefresh} className="rounded p-1 text-muted hover:bg-surface-hover hover:text-text">
        <RefreshCw className="h-3.5 w-3.5" />
      </button>
      <button type="button" aria-label="Don’t include the page" title="Don’t include the page" onClick={onRemove} className="rounded p-1 text-muted hover:bg-surface-hover hover:text-text">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
