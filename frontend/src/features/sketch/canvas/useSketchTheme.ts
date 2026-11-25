import { useEffect, useState } from 'react'
import { readTheme, type SketchTheme } from './palette'

/**
 * The sheet's colours from the app's theme, read again when the theme or the accent
 * changes (both are set on <html>: data-theme and inline CSS variables).
 */
export function useSketchTheme(): SketchTheme {
  const [theme, setTheme] = useState(readTheme)
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      const next = readTheme(root)
      setTheme((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next))
    })
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] })
    return () => observer.disconnect()
  }, [])
  return theme
}
