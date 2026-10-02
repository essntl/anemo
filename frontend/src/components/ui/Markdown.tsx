import { memo, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import { Link } from 'react-router'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { isAppLink } from '@/lib/appLinks'
import { stripCitationMarkup } from '@/lib/citations'

function CodeBlock({ children, ...rest }: ComponentPropsWithoutRef<'pre'>) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  // The language comes from the `language-xyz` class on the inner <code>.
  const child = Array.isArray(children) ? children[0] : children
  const className = (child as { props?: { className?: string } })?.props?.className ?? ''
  const language = /language-([\w-]+)/.exec(className)?.[1] ?? 'text'

  const copy = async () => {
    await navigator.clipboard.writeText(ref.current?.innerText ?? '')
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-border bg-surface-2">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] text-muted">
        <span className="font-mono">{language}</span>
        <button type="button" onClick={copy} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-hover hover:text-text">
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={ref} className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed" {...rest}>
        {children}
      </pre>
    </div>
  )
}

/** A link to a page of the app opens here; a link to another site opens in a new tab. */
function Anchor({ href, children }: ComponentPropsWithoutRef<'a'>) {
  if (href && isAppLink(href)) return <Link to={href}>{children}</Link>
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
}

/** Wide tables scroll sideways by themselves (see .table-scroll in app.css). */
function Table({ children }: ComponentPropsWithoutRef<'table'>) {
  return <div className="table-scroll"><table>{children}</table></div>
}

/** Renders Markdown (GFM tables, task lists, highlighted code). */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: CodeBlock,
          a: Anchor,
          table: Table,
        }}
      >
        {stripCitationMarkup(text)}
      </ReactMarkdown>
    </div>
  )
})
