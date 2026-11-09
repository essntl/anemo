/**
 * HTML from a page (Readability's main content) to clean Markdown. Runs in the extension
 * (the side panel or worker page), never in the web page. Scripts, styles, forms and
 * images' data URIs are dropped; links keep their absolute address.
 */
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

export function htmlToMarkdown(html: string, baseUrl: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const el of doc.querySelectorAll('script, style, noscript, iframe, form, button, input, select, textarea, svg, canvas')) el.remove()
  for (const a of doc.querySelectorAll('a[href]')) {
    try {
      const href = new URL(a.getAttribute('href') ?? '', baseUrl)
      if (href.protocol === 'http:' || href.protocol === 'https:') a.setAttribute('href', href.href)
      else a.removeAttribute('href')
    } catch {
      a.removeAttribute('href')
    }
  }
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? ''
    try {
      const abs = new URL(src, baseUrl)
      if (abs.protocol === 'http:' || abs.protocol === 'https:') img.setAttribute('src', abs.href)
      else img.remove()
    } catch {
      img.remove()
    }
  }
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' })
  service.use(gfm)
  return service
    .turndown(doc.body)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
