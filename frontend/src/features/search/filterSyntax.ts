/** Typing `key:value` filters in a search box (the server reads them; see FilterChips). */
import type { PropertyDefinition } from '@/features/properties/api'

/** The `key:partial` being typed at the end of the query, if `key` is a property with values. */
export function typingFilter(query: string, properties: PropertyDefinition[]): { definition: PropertyDefinition; partial: string } | null {
  const m = /(?:^|\s)([a-z][a-z0-9_-]*):("?)([^\s"]*)$/.exec(query)
  if (!m) return null
  const definition = properties.find((p) => p.key === m[1] && (p.type === 'select' || p.type === 'multi_select'))
  return definition ? { definition, partial: m[3].toLowerCase() } : null
}

/** The query with the `key:partial` at its end replaced by `key:slug `. */
export function completeFilter(query: string, slug: string): string {
  return query.replace(/([a-z][a-z0-9_-]*):"?[^\s"]*$/, (_, key: string) => `${key}:${slug} `)
}
