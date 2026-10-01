import { memo, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
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

/** Renders assistant Markdown (GFM tables, task lists, highlighted code). */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: CodeBlock,
          a: ({ ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {stripCitationMarkup(text)}
      </ReactMarkdown>
    </div>
  )
})
