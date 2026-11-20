/**
 * Filters typed into a search (`client:ludmyla-doula type:brief in:tech-services price`),
 * shown as chips. The server reads them; a value that doesn't exist is an error chip,
 * with the closest existing values. While a `key:` is being typed, its values are
 * suggested.
 */
import { AlertTriangle, SlidersHorizontal } from 'lucide-react'
import { useProperties } from '@/features/properties/api'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import type { SearchFilter } from './api'
import { completeFilter, typingFilter } from './filterSyntax'

export function FilterChips({ filters, className }: { filters: SearchFilter[]; className?: string }) {
  if (filters.length === 0) return null
  return (
    <ul className={cn('flex flex-wrap gap-1.5', className)} aria-label={t('Filters')}>
      {filters.map((f, i) => (
        <li key={`${f.key}:${f.value}:${i}`}
          title={f.ok ? undefined : [f.message, f.suggestions.length ? t('Did you mean {values}?', { values: f.suggestions.join(', ') }) : ''].filter(Boolean).join(' ')}
          className={cn('inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium',
            f.ok ? 'bg-accent-soft text-accent' : 'bg-error/10 text-error')}>
          {f.ok ? <SlidersHorizontal className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
          {f.label}
          {!f.ok && f.suggestions.length > 0 && <span className="font-normal">· {t('did you mean {value}?', { value: f.suggestions[0] })}</span>}
        </li>
      ))}
    </ul>
  )
}

/** Values of the property being typed, to pick from. */
export function FilterSuggestions({ query, onPick }: { query: string; onPick: (query: string) => void }) {
  const properties = useProperties()
  const typing = typingFilter(query, properties.data ?? [])
  if (!typing) return null
  const options = typing.definition.options.filter(
    (o) => !typing.partial || o.slug.includes(typing.partial) || o.label.toLowerCase().includes(typing.partial),
  )
  if (options.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="listbox" aria-label={t('Values of {property}', { property: typing.definition.label })}>
      {options.slice(0, 12).map((o) => (
        <button key={o.id} type="button" role="option" aria-selected={false}
          onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(completeFilter(query, o.slug))}
          className="h-7 rounded-full border border-border px-2.5 text-[12px] hover:bg-surface-hover">
          {o.label}
        </button>
      ))}
    </div>
  )
}
