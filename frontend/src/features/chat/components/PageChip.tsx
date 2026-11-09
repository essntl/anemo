import { useState } from 'react'
import { ExternalLink, FileText, Globe, PlaySquare, TextSelect } from 'lucide-react'
import type { Schemas } from '@/api/client'
import { Dialog } from '@/components/ui/Dialog'
import { usePageContent } from '../api'

type PageSummary = Schemas['PageSummary']

const ICONS = { page: Globe, selection: TextSelect, pdf: FileText, youtube: PlaySquare } as const
const LABELS = { page: 'Web page', selection: 'Selection', pdf: 'PDF', youtube: 'Video transcript' } as const

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Only http(s) addresses become links (the address came from a web page). */
function safeHref(url: string): string | undefined {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined
  } catch {
    return undefined
  }
}

/**
 * A web page attached to a message by the browser extension ("Include this page"). Click
 * to read what was attached. The text came from a web page, so it is shown as plain text.
 */
export function PageChip({ page, conversationId, messageId }: { page: PageSummary; conversationId: string; messageId: string }) {
  const [open, setOpen] = useState(false)
  const content = usePageContent(conversationId, messageId, open)
  const source = (page.source in ICONS ? page.source : 'page') as keyof typeof ICONS
  const Icon = ICONS[source]
  const href = safeHref(page.url)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={page.url}
        className="flex max-w-72 items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-left hover:bg-surface-hover"
      >
        <Icon className="h-4 w-4 shrink-0 text-accent" />
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium">{page.title || host(page.url)}</span>
          <span className="block truncate text-[11.5px] text-muted">
            {host(page.url)} · {page.word_count.toLocaleString()} words{page.truncated ? ' · shortened' : ''}
          </span>
        </span>
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={page.title || host(page.url)}
        description={`${LABELS[source]} from ${host(page.url)}, attached with Anemo Companion${page.truncated ? ' (the middle was left out to keep it short)' : ''}.`}
        className="md:w-[min(92vw,720px)]"
        footer={href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[13px] text-accent hover:underline">
            Open the page <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : undefined}
      >
        {content.isPending && <p className="text-[13px] text-muted">Loading…</p>}
        {content.isError && <p className="text-[13px] text-error">Couldn’t load the attached text.</p>}
        {content.data && (
          <div className="max-h-[60dvh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 text-[13px] leading-relaxed">
            {content.data.content}
          </div>
        )}
      </Dialog>
    </>
  )
}
