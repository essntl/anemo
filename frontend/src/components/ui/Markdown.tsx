import { createContext, createElement, memo, useContext, useMemo, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown, { type ExtraProps, type Options } from 'react-markdown'
import { Link } from 'react-router'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { Check, Copy, Image as ImageIcon, PenLine } from 'lucide-react'
import { DiagramBlock } from '@/components/diagrams/DiagramBlock'
import { protectDollars } from '@/components/diagrams/dollars'
import { isFenceClosed } from '@/components/diagrams/fence'
import { isDiagramLanguage } from '@/components/diagrams/languages'
import { useMath } from '@/components/diagrams/useMath'
import { documentLink, embeddedSketchId, isAppLink, sketchPreviewUrl } from '@/lib/appLinks'
import { useFenceRenderer } from '@/lib/fenceRenderers'
import { stripCitationMarkup } from '@/lib/citations'
import { t } from '@/lib/i18n'
import { imageHost, loadsWithoutAsking } from '@/lib/remoteImages'

/**
 * The Markdown being shown, for code blocks that need their own source. `fences`: blocks
 * may be drawn by a renderer from lib/fenceRenderers (plugins), only in chat answers.
 */
const SourceContext = createContext<{ text: string; streaming: boolean; fences: boolean }>({ text: '', streaming: false, fences: false })

/** The text of a code element's children (react-markdown passes it as a string). */
function textOf(children: unknown): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(textOf).join('')
  return ''
}

function CodeBlock({ children, node, ...rest }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const { text, streaming, fences } = useContext(SourceContext)
  // The language comes from the `language-xyz` class on the inner <code>.
  const child = Array.isArray(children) ? children[0] : children
  const childProps = (child as { props?: { className?: string; children?: unknown } })?.props
  const className = childProps?.className ?? ''
  const language = /language-([\w-]+)/.exec(className)?.[1] ?? 'text'
  const Renderer = useFenceRenderer(language)
  // While an answer is being written, a block is drawn once its closing fence is there.
  const start = node?.position?.start.offset
  const end = node?.position?.end.offset
  const complete = !streaming || (start !== undefined && end !== undefined && isFenceClosed(text.slice(start, end)))
  const source = textOf(childProps?.children).replace(/\n$/, '')

  if (isDiagramLanguage(language) && complete) return <DiagramBlock lang={language} source={source} />

  const copy = async () => {
    await navigator.clipboard.writeText(ref.current?.innerText ?? '')
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const code = (
    <div className="my-3 overflow-hidden rounded-xl border border-border bg-surface-2">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] text-muted">
        <span className="font-mono">{language}</span>
        <button type="button" onClick={copy} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-hover hover:text-text">
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? t('Copied') : t('Copy')}
        </button>
      </div>
      <pre ref={ref} className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed" {...rest}>
        {children}
      </pre>
    </div>
  )
  // A plugin's block (chat answers only): it shows the plain code until it has drawn.
  // (createElement: the renderer is a component registered once, not one made here.)
  if (fences && Renderer && complete) return createElement(Renderer, { lang: language, text: source, fallback: code })
  return code
}

/** A link to a page of the app opens here; a link to another site opens in a new tab. */
function Anchor({ href, children }: ComponentPropsWithoutRef<'a'>) {
  if (href && isAppLink(href)) return <Link to={href}>{children}</Link>
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
}

/** An image from this app shows at once; one from another site waits for a click (see
 * lib/remoteImages.ts), because loading it sends its address to that site. */
function MarkdownImage({ src, alt, title }: ComponentPropsWithoutRef<'img'>) {
  const [shown, setShown] = useState(false)
  const source = typeof src === 'string' ? src : undefined
  const sketchId = embeddedSketchId(source)
  if (sketchId) return <SketchEmbed id={sketchId} alt={alt} title={title} />
  if (shown || loadsWithoutAsking(source)) return <img src={source} alt={alt} title={title} />
  return (
    <button
      type="button"
      onClick={() => setShown(true)}
      title={source}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[12px] text-muted hover:text-text"
    >
      <ImageIcon className="h-3.5 w-3.5" />
      {alt ? t('{alt}: show image from {host}', { alt, host: imageHost(source ?? '') }) : t('show image from {host}', { host: imageHost(source ?? '') })}
    </button>
  )
}

/**
 * An embedded sketch, `![Title](/documents/<id>)`: its image (served by the app), as a
 * link that opens it. Without an image yet (or a link to something else), its name.
 */
function SketchEmbed({ id, alt, title }: { id: string; alt?: string; title?: string }) {
  const [missing, setMissing] = useState(false)
  const name = alt || t('Embedded sketch')
  return (
    <Link to={documentLink(id)} title={title ?? t('Open {name}', { name })} className="sketch-embed inline-block max-w-full no-underline">
      {missing ? (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[12px] text-muted hover:text-text">
          <PenLine className="h-3.5 w-3.5" />
          {name}
        </span>
      ) : (
        <img src={sketchPreviewUrl(id)} alt={alt} onError={() => setMissing(true)}
          className="rounded-md border border-border bg-white" />
      )}
    </Link>
  )
}

/** Wide tables scroll sideways by themselves (see .table-scroll in app.css). */
function Table({ children }: ComponentPropsWithoutRef<'table'>) {
  return <div className="table-scroll"><table>{children}</table></div>
}

// Kept the same between renders, so a drawn diagram isn't mounted again on every update.
const COMPONENTS = { pre: CodeBlock, a: Anchor, table: Table, img: MarkdownImage }
const HIGHLIGHT: NonNullable<Options['rehypePlugins']>[number] = [rehypeHighlight, { detect: false, ignoreMissing: true }]

/**
 * Renders Markdown: GFM tables and task lists, highlighted code, ```mermaid diagrams,
 * ```chart charts and math ($…$, $$…$$). `streaming` is set while an answer is still
 * being written, so diagrams are only drawn once their block is complete. `fences`: code
 * blocks whose language has a renderer in lib/fenceRenderers are drawn by it (chat
 * answers; a plugin's `chat.block`).
 */
export const Markdown = memo(function Markdown({ text, streaming = false, fences = false }: { text: string; streaming?: boolean; fences?: boolean }) {
  const cleaned = stripCitationMarkup(text)
  const math = useMath(cleaned.includes('$'))
  const source = useMemo(() => (math ? protectDollars(cleaned) : cleaned), [math, cleaned])
  const context = useMemo(() => ({ text: source, streaming, fences }), [source, streaming, fences])
  const remarkPlugins = useMemo(() => [remarkGfm, ...(math?.remarkPlugins ?? [])], [math])
  const rehypePlugins = useMemo(() => [...(math?.rehypePlugins ?? []), HIGHLIGHT], [math])
  return (
    <div className="markdown">
      <SourceContext.Provider value={context}>
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={COMPONENTS}>
          {source}
        </ReactMarkdown>
      </SourceContext.Provider>
    </div>
  )
})
