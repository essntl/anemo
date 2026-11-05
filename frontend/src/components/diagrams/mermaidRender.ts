/**
 * Draws a Mermaid diagram to SVG. This module (with Mermaid and DOMPurify) is loaded
 * only when a page shows a diagram, so pages without one stay as fast as before.
 */
import mermaid from 'mermaid'
import type { Palette } from './colors'
import { mermaidConfig } from './mermaidConfig'
import { sanitizeSvg } from './sanitizeSvg'

let counter = 0
let configured = ''

export type MermaidResult = { svg: string; error?: undefined } | { svg?: undefined; error: string }

/** The first line of Mermaid's message, without its internal noise. */
function message(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : 'The diagram could not be drawn.'
  return text.trim().split('\n').slice(0, 4).join('\n') || 'The diagram could not be drawn.'
}

export async function renderMermaid(source: string, palette: Palette): Promise<MermaidResult> {
  const config = mermaidConfig(palette)
  const key = JSON.stringify(config)
  if (key !== configured) {
    mermaid.initialize(config)
    configured = key
  }
  try {
    await mermaid.parse(source)
  } catch (err) {
    return { error: message(err) }
  }
  const id = `diagram-${Date.now().toString(36)}-${counter++}`
  try {
    const { svg } = await mermaid.render(id, source)
    return { svg: sanitizeSvg(svg) }
  } catch (err) {
    return { error: message(err) }
  } finally {
    // Mermaid leaves its scratch element behind when drawing fails.
    document.getElementById(id)?.remove()
    document.getElementById(`d${id}`)?.remove()
  }
}
