/**
 * The ```chart block: a small JSON description of a chart.
 *
 *   {"type": "line", "title": "Visitors", "x": ["Mon", "Tue", "Wed"],
 *    "series": [{"name": "2025", "values": [3, 5, 4]}, {"name": "2026", "values": [4, 6, 7]}]}
 *
 * `type` is line, bar, area or pie. Every series has one value per x label (null for a
 * gap). A pie uses its first series, whose values must not be negative. `unit` (e.g.
 * "%", "€", "h") is shown with the values.
 */

export const CHART_TYPES = ['line', 'bar', 'area', 'pie'] as const
export type ChartType = (typeof CHART_TYPES)[number]

export interface ChartSeries {
  name: string
  values: (number | null)[]
}

export interface ChartSpec {
  type: ChartType
  title?: string
  unit?: string
  x: string[]
  series: ChartSeries[]
}

export const MAX_POINTS = 500
export const MAX_SERIES = 12

export type ChartParse = { spec: ChartSpec; error?: undefined } | { spec?: undefined; error: string }

const fail = (error: string): ChartParse => ({ error })

export function parseChart(source: string): ChartParse {
  let data: unknown
  try {
    data = JSON.parse(source)
  } catch (err) {
    return fail(`The chart is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('The chart must be a JSON object.')
  const d = data as Record<string, unknown>

  if (typeof d.type !== 'string' || !(CHART_TYPES as readonly string[]).includes(d.type)) {
    return fail(`"type" must be one of ${CHART_TYPES.join(', ')}.`)
  }
  const type = d.type as ChartType
  if (d.title !== undefined && typeof d.title !== 'string') return fail('"title" must be text.')
  if (d.unit !== undefined && typeof d.unit !== 'string') return fail('"unit" must be text.')

  if (!Array.isArray(d.x) || d.x.length === 0) return fail('"x" must be a list of labels, one per value.')
  if (d.x.length > MAX_POINTS) return fail(`"x" has more than ${MAX_POINTS} labels.`)
  if (!d.x.every((v) => typeof v === 'string' || typeof v === 'number')) return fail('Every "x" label must be text or a number.')
  const x = d.x.map(String)

  if (!Array.isArray(d.series) || d.series.length === 0) return fail('"series" must be a list with at least one series.')
  if (d.series.length > MAX_SERIES) return fail(`A chart can have at most ${MAX_SERIES} series.`)
  const series: ChartSeries[] = []
  for (const [i, s] of d.series.entries()) {
    const label = `Series ${i + 1}`
    if (!s || typeof s !== 'object') return fail(`${label} must be an object with "name" and "values".`)
    const { name, values } = s as Record<string, unknown>
    if (typeof name !== 'string' || !name.trim()) return fail(`${label} needs a "name".`)
    if (!Array.isArray(values)) return fail(`"${name}" needs "values", a list of numbers.`)
    if (values.length !== x.length) return fail(`"${name}" has ${values.length} values for ${x.length} "x" labels.`)
    if (!values.every((v) => v === null || (typeof v === 'number' && Number.isFinite(v)))) {
      return fail(`"${name}" may only contain numbers (or null for a gap).`)
    }
    series.push({ name, values: values as (number | null)[] })
  }

  if (type === 'pie') {
    const values = series[0].values
    if (values.some((v) => v !== null && v < 0)) return fail('A pie chart cannot have negative values.')
    if (!values.some((v) => v !== null && v > 0)) return fail('A pie chart needs at least one value above 0.')
  }
  return { spec: { type, title: d.title as string | undefined, unit: d.unit as string | undefined, x, series } }
}

/** A value with the chart's unit: "12 h", "40%", "€ 3" stays as the model wrote the unit. */
export function formatValue(value: number | null, unit?: string): string {
  if (value === null) return '–'
  const n = Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (!unit) return n
  return unit === '%' ? `${n}%` : `${n} ${unit}`
}

/** Round numbers for a value axis from `min` to `max`: about `count` steps. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    const pad = Math.abs(min) || 1
    min -= pad
    max += pad
  }
  const raw = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  const start = Math.floor(min / step) * step
  const ticks: number[] = []
  for (let v = start; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)))
  if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + step).toPrecision(12)))
  return ticks
}

/** Text describing the data, for screen readers (the SVG's <desc>). */
export function describeChart(spec: ChartSpec): string {
  const kind = { line: 'Line chart', bar: 'Bar chart', area: 'Area chart', pie: 'Pie chart' }[spec.type]
  const series = spec.type === 'pie' ? spec.series.slice(0, 1) : spec.series
  const parts = series.map(
    (s) => `${s.name}: ${s.values.map((v, i) => `${spec.x[i]} ${formatValue(v, spec.unit)}`).join(', ')}`,
  )
  return `${kind}${spec.title ? ` "${spec.title}"` : ''}. ${parts.join('. ')}.`
}
