/**
 * A ```mermaid or ```chart block drawn as a picture, with a bar to switch to its source,
 * copy it, download it (SVG or PNG) and open it full screen. A block that can't be drawn
 * shows its source and the error, and in a chat a "Fix diagram" button.
 */
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Code2, Copy, Download, Expand, Image as ImageIcon, Wand2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Chart } from './Chart'
import { parseChart } from './chartSpec'
import { usePalette, type Palette } from './colors'
import { DiagramFixContext } from './context'
import { DiagramViewer } from './DiagramViewer'
import { downloadPng, downloadSvg, fileName } from './exportImage'
import type { DiagramLanguage } from './languages'
import type { MermaidResult } from './mermaidRender'

let loader: Promise<typeof import('./mermaidRender')> | null = null
/** Mermaid is loaded the first time a page shows a diagram. */
function loadMermaid() {
  loader ??= import('./mermaidRender').catch((err: unknown) => {
    loader = null
    throw err
  })
  return loader
}

type Drawing =
  | { state: 'loading' }
  | { state: 'ok'; svg?: string; title?: string }
  | { state: 'error'; error: string }

function useMermaid(source: string, palette: Palette, enabled: boolean): Drawing {
  const [result, setResult] = useState<{ key: string; value: MermaidResult } | null>(null)
  const key = `${palette.dark}|${palette.accent}|${source}`
  useEffect(() => {
    if (!enabled) return
    let live = true
    loadMermaid()
      .then((m) => m.renderMermaid(source, palette))
      .then((value) => live && setResult({ key, value }))
      .catch(() => live && setResult({ key, value: { error: 'The diagram renderer could not be loaded.' } }))
    return () => {
      live = false
    }
    // `key` covers the palette's relevant parts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])
  if (!result || result.key !== key) return { state: 'loading' }
  return result.value.error !== undefined ? { state: 'error', error: result.value.error } : { state: 'ok', svg: result.value.svg }
}

const barButton =
  'flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-hover hover:text-text disabled:pointer-events-none disabled:opacity-50 [&_svg]:h-3 [&_svg]:w-3'

export function DiagramBlock({ lang, source, editAction }: {
  lang: DiagramLanguage
  source: string
  /** Extra button in the bar (the document editor's "Edit"). */
  editAction?: ReactNode
}) {
  const palette = usePalette()
  const fix = useContext(DiagramFixContext)
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)
  const [fullScreen, setFullScreen] = useState(false)
  const [busy, setBusy] = useState(false)
  const picture = useRef<HTMLDivElement>(null)

  const chart = useMemo(() => (lang === 'chart' ? parseChart(source) : null), [lang, source])
  const mermaid = useMermaid(source, palette, lang === 'mermaid')
  const drawing: Drawing = chart
    ? chart.error !== undefined ? { state: 'error', error: chart.error } : { state: 'ok', title: chart.spec.title }
    : mermaid
  const label = lang === 'chart' ? 'Chart' : 'Diagram'
  const title = (drawing.state === 'ok' && drawing.title) || label

  const copy = async () => {
    await navigator.clipboard.writeText(source)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  const svgElement = () => picture.current?.querySelector('svg') ?? null
  const save = async (ext: 'svg' | 'png') => {
    const svg = svgElement()
    if (!svg) return
    const name = fileName(drawing.state === 'ok' ? drawing.title : undefined, lang === 'chart' ? 'chart' : 'diagram', ext)
    if (ext === 'svg') return downloadSvg(svg, palette.surface, name)
    setBusy(true)
    try {
      await downloadPng(svg, palette.surface, name)
    } finally {
      setBusy(false)
    }
  }

  const art = (
    chart?.spec ? <Chart spec={chart.spec} palette={palette} />
      : drawing.state === 'ok' && drawing.svg ? <div className="contents" dangerouslySetInnerHTML={{ __html: drawing.svg }} />
        : null
  )
  const failed = drawing.state === 'error'
  const sourceShown = showSource || failed

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-border bg-surface" data-diagram={lang}>
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-1.5 text-[11px] text-muted">
        <span className="mr-auto font-mono">{lang}</span>
        {!failed && (
          <button type="button" className={barButton} onClick={() => setShowSource((s) => !s)} aria-pressed={showSource}
            title={showSource ? `Show the ${label.toLowerCase()}` : 'Show the source'}>
            {showSource ? <ImageIcon /> : <Code2 />}
            {showSource ? label : 'Source'}
          </button>
        )}
        <button type="button" className={barButton} onClick={copy} title="Copy the source">
          {copied ? <Check /> : <Copy />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        {!failed && !showSource && (
          <>
            <button type="button" className={barButton} disabled={drawing.state !== 'ok'} onClick={() => void save('svg')}
              title="Download as SVG" aria-label="Download as SVG">
              <Download />SVG
            </button>
            <button type="button" className={barButton} disabled={drawing.state !== 'ok' || busy} onClick={() => void save('png')}
              title="Download as PNG" aria-label="Download as PNG">
              <Download />PNG
            </button>
            <button type="button" className={barButton} disabled={drawing.state !== 'ok'} onClick={() => setFullScreen(true)}
              title="Full screen" aria-label="Full screen">
              <Expand />
            </button>
          </>
        )}
        {editAction}
      </div>

      {failed && (
        <div className="flex flex-wrap items-start gap-2 border-b border-border bg-surface-2 px-3 py-2 text-[12.5px]">
          <p role="alert" className="min-w-0 flex-1 whitespace-pre-wrap text-error">
            <span className="font-medium">This {label.toLowerCase()} can’t be drawn. </span>{drawing.error}
          </p>
          {fix && (
            <button type="button" onClick={() => fix({ kind: lang, source, error: drawing.error })}
              className="flex shrink-0 items-center gap-1 rounded-control border border-border bg-surface px-2 py-1 text-[12px] font-medium hover:bg-surface-hover [&_svg]:h-3.5 [&_svg]:w-3.5">
              <Wand2 />Fix diagram
            </button>
          )}
        </div>
      )}

      {sourceShown ? (
        <pre className="overflow-x-auto bg-surface-2 p-3 font-mono text-[12.5px] leading-relaxed"><code>{source}</code></pre>
      ) : (
        <div ref={picture} role="figure" aria-label={title}
          className={cn('flex justify-center overflow-x-auto p-3 [&_svg]:h-auto [&_svg]:max-w-full', drawing.state === 'loading' && 'min-h-24 items-center')}>
          {drawing.state === 'loading' ? <span className="text-[12px] text-muted">Drawing…</span> : art}
        </div>
      )}

      {fullScreen && art && (
        <DiagramViewer title={title} onClose={() => setFullScreen(false)}>
          <div className="rounded-xl bg-surface p-4 shadow-float">{art}</div>
        </DiagramViewer>
      )}
    </div>
  )
}
