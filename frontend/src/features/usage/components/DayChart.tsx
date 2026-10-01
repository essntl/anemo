/** A small bar chart: one bar per day. Plain HTML and CSS, no chart library. */
import { dayLabel } from '../ranges'

export interface DayBar {
  day: string // YYYY-MM-DD
  value: number
  /** Shown when hovering or focusing the bar, e.g. "$0.42 · 31 calls". */
  detail: string
}

export function DayChart({ bars, formatValue }: { bars: DayBar[]; formatValue: (value: number) => string }) {
  const max = Math.max(...bars.map((b) => b.value), 0)
  if (bars.length === 0 || max === 0) {
    return <p className="py-8 text-center text-[13px] text-muted">Nothing to show for this period.</p>
  }
  // With many days only some get a label, so they stay readable.
  const labelEvery = Math.ceil(bars.length / 8)
  return (
    <div>
      <div className="mb-1 text-[11px] text-subtle">{formatValue(max)}</div>
      <div className="flex h-36 items-end gap-[3px] border-b border-border" role="img"
        aria-label={`Per day, highest ${formatValue(max)}`}>
        {bars.map((bar) => (
          <div key={bar.day} tabIndex={0} title={`${dayLabel(bar.day)}: ${bar.detail}`}
            className="group flex h-full min-w-0 flex-1 items-end outline-none">
            <div className="w-full rounded-t-[3px] bg-accent/70 transition-colors group-hover:bg-accent group-focus-visible:bg-accent"
              // Days with something always get a visible sliver.
              style={{ height: bar.value > 0 ? `max(2px, ${(bar.value / max) * 100}%)` : 0 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[3px] text-[10.5px] text-subtle">
        {bars.map((bar, i) => (
          <div key={bar.day} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center">
            {i % labelEvery === 0 ? dayLabel(bar.day) : ''}
          </div>
        ))}
      </div>
    </div>
  )
}
