import type { ReactNode } from 'react'
import { Card } from '@/components/ui/Card'

export function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="text-[11.5px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 text-[26px] font-semibold leading-tight tracking-tight tabular-nums">{value}</div>
      {sub && <div className="text-[12.5px] text-muted">{sub}</div>}
    </Card>
  )
}

export function Section({ title, icon, children, action }: { title: string; icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <Card>
      <div className="flex items-center gap-2 px-4 pt-4 md:px-5">
        <span className="text-muted [&>svg]:h-4 [&>svg]:w-4" aria-hidden>{icon}</span>
        <h2 className="flex-1 text-[14px] font-semibold">{title}</h2>
        {action}
      </div>
      <div className="px-4 pb-4 pt-3 md:px-5">{children}</div>
    </Card>
  )
}

/** Labelled horizontal bars, longest first (top tasks, projects). */
export function HBars({ rows, format, empty }: { rows: { key: string; label: ReactNode; value: number; color?: string | null }[]; format: (v: number) => string; empty: string }) {
  const top = Math.max(1, ...rows.map((r) => r.value))
  if (!rows.length) return <p className="text-[13px] text-muted">{empty}</p>
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="mb-1 flex justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate font-medium">{r.label}</span>
            <span className="shrink-0 text-muted tabular-nums">{format(r.value)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <div className="h-full rounded-full" style={{ width: `${(r.value / top) * 100}%`, background: r.color ?? 'var(--accent)' }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Two parts of a whole as one bar (finished vs cut short; by you vs by agents). */
export function SplitBar({ a, b, labels }: { a: number; b: number; labels: [string, string] }) {
  const total = a + b
  const pa = total ? (a / total) * 100 : 0
  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${labels[0]}: ${a}, ${labels[1]}: ${b}`}>
        <div className="h-full bg-accent" style={{ width: `${pa}%` }} />
        <div className="h-full bg-warning" style={{ width: `${total ? 100 - pa : 0}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between text-[12.5px] text-muted tabular-nums">
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent" /> {labels[0]} · {a}</span>
        <span className="flex items-center gap-1.5">{labels[1]} · {b} <span className="h-2 w-2 rounded-full bg-warning" /></span>
      </div>
    </div>
  )
}
