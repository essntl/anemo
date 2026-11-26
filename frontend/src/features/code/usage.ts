/**
 * The usage of the Claude subscription a computer's jobs run on (docs/specs/code-sessions.md
 * §14): how much of the 5-hour and the weekly window is used, and when each resets, from the
 * newest `rate_limit_event` its jobs wrote. Pure: no React, no IO.
 */
import type { Schemas } from '@/api/client'
import { msg, t } from '@/lib/i18n'

export type CodeUsage = Schemas['CodeUsageOut']
export type CodeUsageWindow = Schemas['CodeUsageWindowOut']

/** The windows shown, in this order; others (an Opus-only week, …) only in the details. */
const MAIN_WINDOWS = ['five_hour', 'seven_day'] as const

const LABELS: Record<string, string> = {
  five_hour: msg('5-hour'),
  seven_day: msg('Weekly'),
  seven_day_opus: msg('Weekly (Opus)'),
  seven_day_sonnet: msg('Weekly (Sonnet)'),
}

/** The label of a window: a known one translated, another as Claude Code names it ("seven_day_x" → "seven day x"). */
export function windowLabel(name: string): string {
  const known = LABELS[name]
  return known ? t(known) : name.replace(/_/g, ' ')
}

export interface UsageView {
  name: string
  /** 0…1 (more once the limit was hit); null when it isn't known, or the window has reset since. */
  used: number | null
  resetsAt: Date | null
  /** The reset time has passed since this was seen: what is used now isn't known (probably little). */
  reset: boolean
  /** The limit was hit (Claude Code said `rejected`) and it hasn't reset yet. */
  limited: boolean
  /** Over 80 %, or Claude Code warned. */
  warning: boolean
}

function view(window: CodeUsageWindow, now: Date): UsageView {
  const resetsAt = window.resets_at ? new Date(window.resets_at) : null
  const valid = resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null
  const reset = Boolean(valid && valid.getTime() <= now.getTime())
  const used = reset || typeof window.utilization !== 'number' ? null : window.utilization
  const limited = !reset && (window.status === 'rejected' || (used !== null && used >= 1))
  return {
    name: window.name,
    used,
    resetsAt: valid,
    reset,
    limited,
    warning: !reset && !limited && (window.status === 'allowed_warning' || (used !== null && used >= 0.8)),
  }
}

/** The 5-hour and weekly windows (those it has), then the others. */
export function usageWindows(usage: CodeUsage, now = new Date()): { main: UsageView[]; other: UsageView[] } {
  const views = usage.windows.map((w) => view(w, now))
  const main = MAIN_WINDOWS.map((name) => views.find((v) => v.name === name)).filter((v): v is UsageView => Boolean(v))
  // seven_day_overage_included repeats the weekly window for plans with extra usage.
  const other = views.filter((v) => !main.includes(v) && !v.name.endsWith('_overage_included'))
  // An older shape with only the deciding window: show that one.
  if (!main.length && other.length) return { main: other.slice(0, 1), other: other.slice(1) }
  return { main, other }
}

/** "49 %": a share as a whole percent. */
export const percent = (used: number): string => `${Math.round(used * 100)}%`

/** The usage of the computer with this id, if it reported one. */
export const usageOf = (all: readonly CodeUsage[] | undefined, deviceId: string | undefined): CodeUsage | undefined =>
  deviceId ? all?.find((u) => u.device_id === deviceId) : undefined
