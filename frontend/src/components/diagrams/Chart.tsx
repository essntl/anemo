/**
 * Draws a ```chart block (see chartSpec.ts) as SVG: line, bar, area and pie (as a
 * donut). Colors come from the theme as plain values, so a downloaded SVG or PNG looks
 * the same outside the app. Hovering a point shows its values; the SVG's description
 * lists them all for screen readers.
 */
import { useId, useMemo, useState } from 'react'
import { t } from '@/lib/i18n'
import type { Palette } from './colors'
import { describeChart, formatValue, niceTicks, type ChartSpec } from './chartSpec'

const W = 560
const H = 300
const PAD = { left: 52, right: 16, top: 14, bottom: 34 }

function color(p: Palette, i: number): string {
  return p.series[i % p.series.length]
}

export function Chart({ spec, palette }: { spec: ChartSpec; palette: Palette }) {
  const titleId = useId()
  const descId = useId()
  const [hover, setHover] = useState<number | null>(null)
  const legend = spec.type === 'pie' ? spec.x : spec.series.length > 1 ? spec.series.map((s) => s.name) : []
  const top = PAD.top + (spec.title ? 22 : 0) + (legend.length ? 22 : 0)
  const font = { fontFamily: palette.font }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-labelledby={`${titleId} ${descId}`}
      className="h-auto w-full max-w-[600px] select-none" style={font} onMouseLeave={() => setHover(null)}>
      <title id={titleId}>{spec.title ?? t('Chart')}</title>
      <desc id={descId}>{describeChart(spec)}</desc>
      <rect width={W} height={H} fill={palette.surface} />
      {spec.title && (
        <text x={W / 2} y={PAD.top + 12} textAnchor="middle" fontSize={15} fontWeight={600} fill={palette.text}>
          {spec.title}
        </text>
      )}
      {legend.length > 0 && <Legend names={legend} palette={palette} y={PAD.top + (spec.title ? 22 : 0) + 10} />}
      {spec.type === 'pie'
        ? <Pie spec={spec} palette={palette} top={top} hover={hover} setHover={setHover} />
        : <Cartesian spec={spec} palette={palette} top={top} hover={hover} setHover={setHover} />}
    </svg>
  )
}

function Legend({ names, palette, y }: { names: string[]; palette: Palette; y: number }) {
  // Laid out in one row, roughly by text length; long legends are cut with "…".
  const shown = names.slice(0, 12)
  const widths = shown.map((n) => 24 + Math.min(n.length, 18) * 7.2)
  const total = widths.reduce((a, b) => a + b, 0)
  const first = Math.max(PAD.left, (W - total) / 2)
  const starts = widths.map((_, i) => first + widths.slice(0, i).reduce((a, b) => a + b, 0))
  return (
    <g fontSize={12.5} fill={palette.muted}>
      {shown.map((name, i) => {
        const at = starts[i]
        if (at > W - 40) return null
        return (
          <g key={i} transform={`translate(${at} ${y})`}>
            <rect x={0} y={-8} width={10} height={10} rx={2} fill={color(palette, i)} />
            <text x={15} y={1}>{name.length > 18 ? `${name.slice(0, 17)}…` : name}</text>
          </g>
        )
      })}
    </g>
  )
}

interface PartProps {
  spec: ChartSpec
  palette: Palette
  top: number
  hover: number | null
  setHover: (i: number | null) => void
}

function Cartesian({ spec, palette, top, hover, setHover }: PartProps) {
  const n = spec.x.length
  const plot = { left: PAD.left, right: W - PAD.right, top, bottom: H - PAD.bottom }
  const plotW = plot.right - plot.left
  const plotH = plot.bottom - plot.top
  const found = spec.series.flatMap((s) => s.values.filter((v): v is number => v !== null))
  const values = found.length ? found : [0, 1]
  const lo = Math.min(...values, ...(spec.type === 'line' ? [] : [0]))
  const hi = Math.max(...values, ...(spec.type === 'line' ? [] : [0]))
  const ticks = useMemo(() => niceTicks(lo, hi), [lo, hi])
  const min = ticks[0]
  const max = ticks[ticks.length - 1]
  const y = (v: number) => plot.bottom - ((v - min) / (max - min || 1)) * plotH
  const band = plotW / n
  const cx = (i: number) => (spec.type === 'bar' ? plot.left + band * (i + 0.5) : n === 1 ? plot.left + plotW / 2 : plot.left + (i * plotW) / (n - 1))
  const labelEvery = Math.max(1, Math.ceil(n / Math.floor(plotW / 60)))
  const base = y(Math.max(min, Math.min(0, max)))

  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={plot.left} x2={plot.right} y1={y(t)} y2={y(t)} stroke={palette.border} strokeWidth={1} />
          <text x={plot.left - 8} y={y(t) + 4} textAnchor="end" fontSize={12} fill={palette.muted}>
            {formatValue(t, spec.unit)}
          </text>
        </g>
      ))}
      {spec.x.map((label, i) =>
        i % labelEvery === 0 ? (
          <text key={i} x={cx(i)} y={plot.bottom + 18} textAnchor="middle" fontSize={12} fill={palette.muted}>
            {label.length > 14 ? `${label.slice(0, 13)}…` : label}
          </text>
        ) : null,
      )}

      {spec.type === 'bar'
        ? spec.series.map((s, si) => {
            const groupW = band * 0.72
            const barW = groupW / spec.series.length
            return s.values.map((v, i) =>
              v === null ? null : (
                <rect key={`${si}-${i}`} x={cx(i) - groupW / 2 + si * barW + 1} width={Math.max(1, barW - 2)}
                  y={Math.min(y(v), base)} height={Math.max(1, Math.abs(base - y(v)))} rx={Math.min(3, barW / 4)}
                  fill={color(palette, si)} opacity={hover === null || hover === i ? 1 : 0.55} />
              ),
            )
          })
        : spec.series.map((s, si) => {
            const segments: [number, number][][] = [[]]
            s.values.forEach((v, i) => {
              if (v === null) segments.push([])
              else segments[segments.length - 1].push([cx(i), y(v)])
            })
            const c = color(palette, si)
            return (
              <g key={si}>
                {segments.filter((seg) => seg.length).map((seg, k) => {
                  const line = seg.map(([px, py], j) => `${j ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ')
                  return (
                    <g key={k}>
                      {spec.type === 'area' && (
                        <path d={`${line} L${seg[seg.length - 1][0].toFixed(1)} ${base.toFixed(1)} L${seg[0][0].toFixed(1)} ${base.toFixed(1)} Z`}
                          fill={c} fillOpacity={0.16} />
                      )}
                      <path d={line} fill="none" stroke={c} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
                    </g>
                  )
                })}
                {(n <= 40 || hover !== null) && s.values.map((v, i) =>
                  v === null || (n > 40 && hover !== i) ? null : (
                    <circle key={i} cx={cx(i)} cy={y(v)} r={hover === i ? 4.5 : 3} fill={palette.surface} stroke={c} strokeWidth={2} />
                  ),
                )}
              </g>
            )
          })}

      {hover !== null && spec.type !== 'bar' && (
        <line x1={cx(hover)} x2={cx(hover)} y1={plot.top} y2={plot.bottom} stroke={palette.subtle} strokeDasharray="3 3" />
      )}
      {/* Hover targets, one per x label. */}
      {spec.x.map((_, i) => {
        const w = spec.type === 'bar' || n === 1 ? band : plotW / (n - 1)
        return (
          <rect key={i} x={cx(i) - w / 2} y={plot.top} width={w} height={plotH} fill="transparent"
            onMouseEnter={() => setHover(i)} />
        )
      })}
      {hover !== null && (
        <Tooltip palette={palette} x={cx(hover)} y={plot.top} bounds={plot}
          title={spec.x[hover]}
          rows={spec.series.map((s, si) => ({ name: s.name, value: formatValue(s.values[hover], spec.unit), color: color(palette, si) }))} />
      )}
    </g>
  )
}

function Pie({ spec, palette, top, hover, setHover }: PartProps) {
  const values = spec.series[0].values.map((v) => (v === null ? 0 : v))
  const total = values.reduce((a, b) => a + b, 0)
  const cxp = W / 2
  const cyp = top + (H - top - 12) / 2
  const r = Math.min((H - top - 16) / 2, 130)
  const inner = r * 0.58
  // Where each slice starts, going clockwise from the top.
  const starts = values.map((_, i) => -Math.PI / 2 + (values.slice(0, i).reduce((a, b) => a + b, 0) / total) * Math.PI * 2)
  const point = (a: number, radius: number) => [cxp + radius * Math.cos(a), cyp + radius * Math.sin(a)]
  const shown = hover !== null ? hover : null

  return (
    <g>
      {values.map((v, i) => {
        if (v <= 0) return null
        const start = starts[i]
        const sweep = (v / total) * Math.PI * 2
        const end = start + Math.min(sweep, Math.PI * 2 - 1e-4)
        const large = end - start > Math.PI ? 1 : 0
        const grow = hover === i ? 4 : 0
        const [x1, y1] = point(start, r + grow)
        const [x2, y2] = point(end, r + grow)
        const [x3, y3] = point(end, inner)
        const [x4, y4] = point(start, inner)
        const d = `M${x1} ${y1} A${r + grow} ${r + grow} 0 ${large} 1 ${x2} ${y2} L${x3} ${y3} A${inner} ${inner} 0 ${large} 0 ${x4} ${y4} Z`
        return (
          <path key={i} d={d} fill={color(palette, i)} stroke={palette.surface} strokeWidth={2}
            opacity={hover === null || hover === i ? 1 : 0.6}
            onMouseEnter={() => setHover(i)} />
        )
      })}
      <text x={cxp} y={cyp - 4} textAnchor="middle" fontSize={15} fontWeight={600} fill={palette.text}>
        {shown === null ? formatValue(total, spec.unit) : formatValue(values[shown], spec.unit)}
      </text>
      <text x={cxp} y={cyp + 14} textAnchor="middle" fontSize={12} fill={palette.muted}>
        {shown === null ? t('Total') : `${spec.x[shown]} · ${Math.round((values[shown] / total) * 1000) / 10}%`}
      </text>
    </g>
  )
}

function Tooltip({ palette, x, y, bounds, title, rows }: {
  palette: Palette
  x: number
  y: number
  bounds: { left: number; right: number }
  title: string
  rows: { name: string; value: string; color: string }[]
}) {
  const shown = rows.slice(0, 8)
  const width = Math.max(
    90,
    Math.min(240, 24 + Math.max(title.length * 7.2, ...shown.map((r) => (r.name.length + r.value.length + 2) * 7))),
  )
  const height = 26 + shown.length * 18
  const left = x + 12 + width > bounds.right ? x - 12 - width : x + 12
  return (
    <g transform={`translate(${Math.max(bounds.left, left)} ${y + 4})`} pointerEvents="none" data-testid="chart-tooltip">
      <rect width={width} height={height} rx={6} fill={palette.surface} stroke={palette.border} />
      <text x={10} y={16} fontSize={12.5} fontWeight={600} fill={palette.text}>{title}</text>
      {shown.map((row, i) => (
        <g key={i} transform={`translate(10 ${34 + i * 18})`}>
          <rect x={0} y={-8} width={8} height={8} rx={2} fill={row.color} />
          <text x={13} y={0} fontSize={12.5} fill={palette.muted}>
            {row.name}: <tspan fill={palette.text} fontWeight={600}>{row.value}</tspan>
          </text>
        </g>
      ))}
    </g>
  )
}
