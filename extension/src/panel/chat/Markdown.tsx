/**
 * Renders an answer's Markdown: GFM, highlighted code with a Copy button, KaTeX math.
 *
 * react-markdown builds React elements and never inserts raw HTML, so model output can't
 * add scripts or markup (HTML in the text shows as text). Links open in a new tab; a
 * link to a page of Anemo (/documents/…, /c/…) opens in Anemo. Images from other sites
 * wait for a click, as in Anemo (loading one would send its address to that site).
 * KaTeX runs with `trust` off and its fonts are bundled: nothing loads from a CDN.
 */
import { memo, useMemo, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown, { type Options } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { Check, Copy, Image as ImageIcon } from 'lucide-react'
import 'katex/dist/katex.min.css'
import { stripCitationMarkup } from '@/shared/text'
import { resolveHref } from './links'

function CodeBlock({ children, ...rest }: ComponentPropsWithoutRef<'pre'>) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const child = Array.isArray(children) ? children[0] : children
  const className = (child as { props?: { className?: string } })?.props?.className ?? ''
  const language = /language-([\w-]+)/.exec(className)?.[1] ?? 'text'
  const copy = async () => {
    await navigator.clipboard.writeText(ref.current?.innerText ?? '')
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="my-2.5 overflow-hidden rounded-xl border border-border bg-surface-2">
      <div className="flex items-center justify-between border-b border-border px-2.5 py-1 text-[11px] text-muted">
        <span className="font-mono">{language}</span>
        <button type="button" onClick={() => void copy()} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-hover hover:text-text">
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={ref} className="overflow-x-auto p-2.5 font-mono text-[12px] leading-relaxed" {...rest}>
        {children}
      </pre>
    </div>
  )
}

function Table({ children }: ComponentPropsWithoutRef<'table'>) {
  return <div className="table-scroll"><table>{children}</table></div>
}

const HIGHLIGHT: NonNullable<Options['rehypePlugins']>[number] = [rehypeHighlight, { detect: false, ignoreMissing: true }]
const KATEX: NonNullable<Options['rehypePlugins']>[number] = [rehypeKatex, { trust: false, strict: 'ignore', throwOnError: false }]

export const Markdown = memo(function Markdown({ text, serverUrl }: { text: string; serverUrl: string }) {
  const source = stripCitationMarkup(text)
  const components = useMemo<Options['components']>(
    () => ({
      pre: CodeBlock,
      table: Table,
      a: ({ href, children }) => {
        const target = resolveHref(href, serverUrl)
        return target ? <a href={target} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>
      },
      img: ({ src, alt }) => <PanelImage src={typeof src === 'string' ? src : undefined} alt={alt} serverUrl={serverUrl} />,
    }),
    [serverUrl],
  )
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[KATEX, HIGHLIGHT]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  )
})

/** Images from Anemo itself would need the token; images from other sites wait for a click. */
function PanelImage({ src, alt, serverUrl }: { src?: string; alt?: string; serverUrl: string }) {
  const [shown, setShown] = useState(false)
  const target = resolveHref(src, serverUrl)
  if (!target) return null
  if (shown) return <img src={target} alt={alt ?? ''} referrerPolicy="no-referrer" />
  return (
    <button type="button" onClick={() => setShown(true)} title={target} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[12px] text-muted hover:text-text">
      <ImageIcon className="h-3.5 w-3.5" />
      {alt ? `${alt}: ` : ''}show image from {new URL(target).host}
    </button>
  )
}
