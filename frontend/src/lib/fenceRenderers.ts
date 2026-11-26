/**
 * Renderers for fenced code blocks in chat answers, added at run time.
 *
 * `Markdown` (components/ui) draws a ```lang block as code, or as a diagram for the
 * languages it knows itself. A feature can draw other languages: the plugins feature
 * registers one renderer per `chat.block` fence of an enabled plugin. Shared code can't
 * import a feature (lint:imports), so the feature fills this registry and `Markdown`
 * only looks languages up here.
 *
 *   const stop = registerFenceRenderer('today-kanban', KanbanBlock)
 *   ...
 *   stop()   // the plugin was turned off: back to a plain code block
 *
 * A renderer gets the block's language and text, and the plain code block as `fallback`,
 * to show while it is loading or when it fails.
 */
import { type ComponentType, type ReactNode, useSyncExternalStore } from 'react'

export interface FenceRendererProps {
  lang: string
  text: string
  /** The ordinary code block, for while the renderer loads or when it can't draw. */
  fallback: ReactNode
}

export type FenceRenderer = ComponentType<FenceRendererProps>

/** Languages Anemo draws itself: never handed to a renderer from here. */
const RESERVED = new Set(['mermaid', 'chart', 'math'])

const renderers = new Map<string, FenceRenderer>()
const listeners = new Set<() => void>()
// A new Map on every change, so useSyncExternalStore sees that something changed.
let snapshot: ReadonlyMap<string, FenceRenderer> = new Map()

function changed() {
  snapshot = new Map(renderers)
  for (const listener of listeners) listener()
}

/**
 * Draw ```lang blocks with `renderer`. Returns a function that removes it again (only if
 * it is still the one registered, so an older registration can't remove a newer one).
 */
export function registerFenceRenderer(lang: string, renderer: FenceRenderer): () => void {
  const key = lang.toLowerCase()
  if (RESERVED.has(key)) return () => {}
  renderers.set(key, renderer)
  changed()
  return () => {
    if (renderers.get(key) !== renderer) return
    renderers.delete(key)
    changed()
  }
}

/** The renderer for a language, if one is registered. */
export function fenceRenderer(lang: string): FenceRenderer | undefined {
  return snapshot.get(lang.toLowerCase())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The renderer for a language, kept up to date as renderers come and go. */
export function useFenceRenderer(lang: string): FenceRenderer | undefined {
  const all = useSyncExternalStore(subscribe, () => snapshot)
  return all.get(lang.toLowerCase())
}
