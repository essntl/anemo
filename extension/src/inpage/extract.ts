/**
 * Runs inside a web page (injected with chrome.scripting.executeScript into the
 * extension's isolated world, so the page's own scripts can't see or change it, and the
 * page's CSP doesn't apply). Reads the page; changes nothing; sends nothing anywhere: the
 * result goes back to the extension as the return value of the injection.
 */
import { Readability } from '@mozilla/readability'
import { htmlToMarkdown } from '@/shared/markdown'

export type ExtractMethod = 'readability' | 'selection' | 'body'

export interface Extracted {
  url: string
  title: string
  lang: string
  byline: string | null
  siteName: string | null
  /** The main content as clean Markdown (Readability, converted here: the page has a DOM,
   *  the extension's worker doesn't). Null when Readability found no article. */
  markdown: string | null
  /** The main content as plain text. */
  text: string
  /** What is selected, if anything. */
  selection: string
  /** The paragraph around the selection (for explanations in context). */
  selectionContext: string
  method: ExtractMethod
  contentType: string
}

const MAX_HTML = 3_000_000
const MIN_ARTICLE_CHARS = 250

function selectionText(): { text: string; context: string } {
  const sel = window.getSelection()
  const text = sel?.toString().trim() ?? ''
  if (!sel || !text || sel.rangeCount === 0) return { text: '', context: '' }
  let node: Node | null = sel.getRangeAt(0).commonAncestorContainer
  while (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentNode
  let el = node as HTMLElement | null
  // The nearest block around the selection (a paragraph, list item, cell, ...).
  while (el && el !== document.body && !/^(P|LI|TD|TH|BLOCKQUOTE|DD|DT|H[1-6]|PRE|FIGCAPTION|ARTICLE|SECTION|DIV)$/.test(el.tagName)) {
    el = el.parentElement
  }
  const context = (el?.innerText || el?.textContent || '').trim().slice(0, 4000)
  return { text: text.slice(0, 100_000), context }
}

export function extract(): Extracted {
  const { text: selection, context } = selectionText()
  const base = {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || navigator.language,
    selection,
    selectionContext: context,
    contentType: document.contentType,
  }
  try {
    const clone = document.cloneNode(true) as Document
    const article = new Readability(clone, { charThreshold: MIN_ARTICLE_CHARS }).parse()
    const text = article?.textContent?.trim() ?? ''
    if (article && text.length >= MIN_ARTICLE_CHARS) {
      let markdown: string | null = null
      try {
        markdown = htmlToMarkdown((article.content ?? '').slice(0, MAX_HTML), location.href) || null
      } catch {
        markdown = null // e.g. a page that forbids parsing HTML strings: plain text below
      }
      return {
        ...base,
        title: article.title || base.title,
        byline: article.byline ?? null,
        siteName: article.siteName ?? null,
        markdown,
        text,
        method: 'readability',
      }
    }
  } catch {
    // Some pages break Readability: fall back below.
  }
  if (selection) return { ...base, byline: null, siteName: null, markdown: null, text: selection, method: 'selection' }
  return { ...base, byline: null, siteName: null, markdown: null, text: (document.body?.innerText || document.body?.textContent || '').trim(), method: 'body' }
}
