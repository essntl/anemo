/**
 * A view's query as the text the search box understands, and back: the filters a view
 * has are edited as `client:ludmyla-doula tags:legal in:tech-services some words`.
 * (The server reads the text; see features/search/service.py.)
 */
import type { Project } from '@/features/tasks/api'
import type { ViewQuery } from './api'

const quote = (value: string) => (/\s|"/.test(value) ? `"${value.replace(/"/g, '')}"` : value)

function filterValue(spec: unknown): string | null {
  if (spec === null || spec === undefined) return null
  if (typeof spec !== 'object') return String(spec)
  const op = spec as { has?: unknown; in?: unknown }
  if (op.has !== undefined) return String(op.has)
  if (Array.isArray(op.in) && op.in.length === 1) return String(op.in[0])
  return null // missing / several values: not expressible as key:value
}

/** The query as search text, or null when it has conditions the text can't say. */
export function queryText(q: ViewQuery, projects: Project[]): string | null {
  const parts: string[] = []
  for (const [key, spec] of Object.entries(q.properties ?? {})) {
    const value = filterValue(spec)
    if (value === null) return null
    parts.push(`${key}:${quote(value)}`)
  }
  if (q.project_id) {
    const project = projects.find((p) => p.id === q.project_id)
    if (!project) return null
    parts.push(`in:${project.slug}`)
  }
  if (q.folder) parts.push(`in:${quote(q.folder)}`)
  if (q.text) parts.push(q.text)
  return parts.join(' ')
}

/** The property keys a table shows: those asked for, else every one the rows have. */
export function tableColumns(q: ViewQuery, rows: { properties: Record<string, unknown> }[], order: string[]): string[] {
  if (q.columns && q.columns.length > 0) return q.columns
  const used = new Set(rows.flatMap((r) => Object.keys(r.properties)))
  return order.filter((key) => used.has(key))
}

type Sortable = { title: string; updated_at: string; properties: Record<string, unknown> }

/** Rows sorted by a column (title, updated_at or a property key); rows without a value go last. */
export function sortRows<T extends Sortable>(rows: T[], key: string, desc: boolean): T[] {
  const value = (r: T): string => {
    if (key === 'title') return r.title.toLowerCase()
    if (key === 'updated_at') return r.updated_at
    const v = r.properties[key]
    return v === undefined || v === null ? '' : Array.isArray(v) ? v.join(',') : String(v)
  }
  const present = rows.filter((r) => value(r) !== '')
  const absent = rows.filter((r) => value(r) === '')
  present.sort((a, b) => (desc ? -1 : 1) * value(a).localeCompare(value(b), undefined, { numeric: true }))
  return [...present, ...absent]
}

/** Rows by the value of a select property (a board's columns); "" for rows without one. */
export function groupRows<T extends Sortable>(rows: T[], key: string, values: string[]): [string, T[]][] {
  const groups = new Map<string, T[]>([...values.map((v) => [v, []] as [string, T[]]), ['', []]])
  for (const row of rows) {
    const v = row.properties[key]
    for (const one of Array.isArray(v) ? (v.length ? v : ['']) : [v ?? '']) {
      const name = String(one)
      if (!groups.has(name)) groups.set(name, [])
      groups.get(name)!.push(row)
    }
  }
  return [...groups.entries()].filter(([name, list]) => name !== '' || list.length > 0)
}
