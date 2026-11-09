/**
 * Reading the page in a tab, on an explicit action (a click in the panel, a context menu,
 * a shortcut). Web pages: an injected script reads the main content (Readability →
 * selection → visible text). PDFs in Chrome's viewer: the extension fetches the PDF with
 * the browser's own login to the site and Anemo extracts its text page by page.
 */
import { unwrap, type Api } from './api'
import { countWords, truncateMiddle } from './truncate'
import type { Extracted } from '@/inpage/extract'

export type PageSource = 'page' | 'selection' | 'pdf' | 'youtube'

export interface PageContext {
  url: string
  title: string
  source: PageSource
  content: string
  truncated: boolean
  wordCount: number
  /** The selection when the page was read, and the paragraph around it. */
  selection: string
  selectionContext: string
}

export type ReadFailure =
  /** No access to this site yet (see the question about page access). */
  | { reason: 'no_access'; origin: string | null }
  /** A page no extension may read (chrome://, the Web Store, other extensions). */
  | { reason: 'restricted' }
  /** A scanned PDF without text, an unreadable PDF, or a fetch that failed. */
  | { reason: 'pdf'; message: string }
  | { reason: 'empty' }
  | { reason: 'failed'; message: string }

export class PageReadError extends Error {
  constructor(readonly failure: ReadFailure) {
    super(failure.reason)
  }
}

export function looksLikePdf(url: string, contentType?: string): boolean {
  if (contentType === 'application/pdf') return true
  try {
    return /\.pdf$/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

function originOf(url: string | undefined): string | null {
  try {
    const u = new URL(url ?? '')
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

/** Chrome's error for a tab we may not touch, as a reason. */
export function classifyScriptError(message: string, url?: string): ReadFailure {
  if (/chrome:\/\/|chrome-extension:\/\/|extensions gallery|webstore|cannot be scripted|edge:\/\//i.test(message)) return { reason: 'restricted' }
  if (/Cannot access contents|permission|host permissions|Missing host/i.test(message)) return { reason: 'no_access', origin: originOf(url) }
  return { reason: 'failed', message }
}

/** Runs the extraction script in the tab's main frame. */
export async function extractFromTab(tabId: number, url?: string): Promise<Extracted> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['inpage/extract.js'] })
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (window as unknown as { __anemoExtract: () => unknown }).__anemoExtract(),
    })
    return result.result as Extracted
  } catch (err) {
    throw new PageReadError(classifyScriptError(err instanceof Error ? err.message : String(err), url))
  }
}

/** The PDF's text, page by page, as "[Page n]" sections. */
export async function readPdf(api: Api, url: string): Promise<{ text: string; title: string }> {
  let blob: Blob
  try {
    const res = await fetch(url, { credentials: 'include' })
    if (!res.ok) throw new Error(`The PDF couldn’t be downloaded (HTTP ${res.status}).`)
    blob = await res.blob()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new PageReadError(url.startsWith('file:')
      ? { reason: 'pdf', message: 'To read PDFs from your computer, switch on “Allow access to file URLs” for Anemo Companion in chrome://extensions.' }
      : { reason: 'pdf', message: msg })
  }
  const form = new FormData()
  form.append('file', blob, 'document.pdf')
  let out
  try {
    out = unwrap(await api.POST('/api/extension/pdf-text', { body: form as never, bodySerializer: (b) => b as unknown as FormData }))
  } catch (err) {
    throw new PageReadError({ reason: 'pdf', message: err instanceof Error ? err.message : String(err) })
  }
  if (!out.has_text) throw new PageReadError({ reason: 'pdf', message: 'This PDF has no text layer (a scan): there is nothing to read without OCR.' })
  const more = out.page_count > out.pages_read ? `\n\n[Only the first ${out.pages_read} of ${out.page_count} pages were read.]` : ''
  const text = out.pages.map((p) => `[Page ${p.number}]\n${p.text}`).join('\n\n') + more
  const title = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? 'PDF')
  return { text, title }
}

/** Turns what was read into the page context sent with a message. */
export function toContext(e: Extracted, preferSelection = false): PageContext {
  const useSelection = preferSelection && e.selection
  const body = useSelection ? e.selection : (e.markdown ?? e.text)
  const cut = truncateMiddle(body)
  return {
    url: e.url,
    title: e.title,
    source: useSelection || e.method === 'selection' ? 'selection' : 'page',
    content: cut.text,
    truncated: cut.truncated,
    wordCount: countWords(body),
    selection: e.selection,
    selectionContext: e.selectionContext,
  }
}

/** Reads a tab's page (or PDF) as page context. Throws PageReadError. */
export async function readPage(api: Api, tab: { id?: number; url?: string; title?: string }, opts: { preferSelection?: boolean } = {}): Promise<PageContext> {
  if (tab.id === undefined) throw new PageReadError({ reason: 'failed', message: 'No tab.' })
  if (tab.url && looksLikePdf(tab.url)) return pdfContext(api, tab.url)
  const extracted = await extractFromTab(tab.id, tab.url)
  if (looksLikePdf(extracted.url, extracted.contentType)) return pdfContext(api, extracted.url)
  const context = toContext(extracted, opts.preferSelection)
  if (!context.content.trim()) throw new PageReadError({ reason: 'empty' })
  return context
}

async function pdfContext(api: Api, url: string): Promise<PageContext> {
  const { text, title } = await readPdf(api, url)
  const cut = truncateMiddle(text)
  return { url, title, source: 'pdf', content: cut.text, truncated: cut.truncated, wordCount: countWords(text), selection: '', selectionContext: '' }
}
