import { lazy, Suspense, useState, type CSSProperties, type ReactNode } from 'react'
import { Puzzle } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * A plugin's icon: its own picture (icon.png from the package) or, without one, a puzzle
 * piece on the accent tile. Always exactly `size` pixels square, so nothing moves when the
 * picture arrives (and the card → page transition has a fixed shape to morph).
 */
export function PluginIcon({ url, size = 40, className, style }: { url: string | null | undefined; size?: number; className?: string; style?: CSSProperties }) {
  const [broken, setBroken] = useState(false)
  const box = { width: size, height: size, ...style }
  const radius = size >= 48 ? 'rounded-2xl' : 'rounded-xl'
  if (url && !broken) {
    return <img src={url} alt="" width={size} height={size} draggable={false} onError={() => setBroken(true)}
      className={cn('shrink-0 bg-surface-2 object-cover', radius, className)} style={box} />
  }
  return (
    <span aria-hidden className={cn('flex shrink-0 items-center justify-center bg-accent-soft text-accent', radius, className)} style={box}>
      <Puzzle style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  )
}

// The names of Anemo's icon set and a loader per icon are a big table: it is loaded only
// when a plugin first names an icon.
const LucideByName = lazy(() => import('./LucideByName'))

/**
 * An icon of Anemo's set by its lucide name ("calendar-check"), as a plugin's page or
 * command names it. Each icon is loaded on its own when first shown; an unknown name shows
 * `fallback` (the plugin's own icon, contract §2.4).
 */
export function NamedIcon({ name, fallback, className }: { name: string | null | undefined; fallback: ReactNode; className?: string }) {
  if (!name) return <>{fallback}</>
  return (
    <Suspense fallback={<span className={className} />}>
      <LucideByName name={name} className={className} fallback={fallback} />
    </Suspense>
  )
}
