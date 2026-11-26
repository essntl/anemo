/**
 * An icon of lucide's set by name, for NamedIcon (PluginIcon.tsx), which loads this file
 * only when needed: the table of every icon name is large. Each icon is its own small file,
 * fetched the first time it is shown.
 */
import type { ReactNode } from 'react'
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic'

const KNOWN = new Set<string>(iconNames)

export default function LucideByName({ name, className, fallback }: { name: string; className?: string; fallback: ReactNode }) {
  if (!KNOWN.has(name)) return <>{fallback}</>
  return <DynamicIcon name={name as IconName} className={className} fallback={() => <span className={className} />} />
}
