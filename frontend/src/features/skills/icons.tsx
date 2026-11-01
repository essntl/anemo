import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/cn'
import { SKILL_ICONS } from './iconMap'

/** A skill's icon by its stored name (a sparkle when the name is unknown). */
export function SkillIcon({ name, className }: { name: string; className?: string }) {
  const Icon = SKILL_ICONS[name] ?? Sparkles
  return <Icon className={cn('h-4 w-4 shrink-0', className)} aria-hidden />
}
