/** The height of a row of the Git view's graph: it follows Settings → Appearance → Density. */
import { useSyncExternalStore } from 'react'

function densityNow(): string {
  return document.documentElement.dataset.density ?? 'comfortable'
}

function onDensityChange(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-density'] })
  return () => observer.disconnect()
}

/** The height of a row in pixels: 32, or 26 when the app is compact. */
export function useRowHeight(): number {
  const density = useSyncExternalStore(onDensityChange, densityNow)
  return density === 'compact' ? 26 : 32
}
