/**
 * The per-automation run settings of the dialog (tools, limits, retention, the tools
 * that may reach people without asking, the change check, the state note) as form
 * values, and back to what the API takes. Empty fields mean "no setting of its own".
 */
import type { Automation, AutomationSave } from './api'

export interface CheckRow {
  tool: string
  /** The arguments as JSON text, as typed. */
  args: string
}

export interface RunSettingsForm {
  /** null: the usual toolset. Otherwise only these tools. */
  tools: string[] | null
  maxToolCalls: string
  maxMinutes: string
  /** '' keeps run chats. */
  retentionDays: string
  /** Tool names, separated by commas. */
  contactsAllowed: string
  checks: CheckRow[]
  runAnywayHours: string
  stateNote: string
  /** Only a note the user changed is saved: a run may have replaced it meanwhile. */
  stateNoteEdited: boolean
}

type RunSettingsBody = Pick<
  AutomationSave,
  | 'tool_allowlist'
  | 'max_tool_calls'
  | 'max_runtime_s'
  | 'chat_retention_days'
  | 'contact_tools_allowed'
  | 'change_check'
  | 'run_anyway_hours'
  | 'state_note'
>

/** What new automations start with (the server's defaults). */
export const NEW_LIMITS = { maxToolCalls: '30', maxMinutes: '5' }

const text = (n: number | null | undefined) => (n == null ? '' : String(n))

export function runSettingsFrom(a: Automation | null): RunSettingsForm {
  if (!a) {
    return {
      tools: null, ...NEW_LIMITS, retentionDays: '', contactsAllowed: '', checks: [], runAnywayHours: '', stateNote: '', stateNoteEdited: false,
    }
  }
  return {
    tools: a.tool_allowlist ?? null,
    maxToolCalls: text(a.max_tool_calls),
    maxMinutes: a.max_runtime_s == null ? '' : String(Math.round(a.max_runtime_s / 60)),
    retentionDays: text(a.chat_retention_days),
    contactsAllowed: (a.contact_tools_allowed ?? []).join(', '),
    checks: (a.change_check ?? []).map((c) => ({ tool: c.tool, args: JSON.stringify(c.args ?? {}) })),
    runAnywayHours: text(a.run_anyway_hours),
    stateNote: a.state_note ?? '',
    stateNoteEdited: false,
  }
}

const whole = (value: string): number | null => {
  const n = Number(value.trim())
  return value.trim() === '' || !Number.isInteger(n) || n < 1 ? null : n
}

/** The arguments of a check row, or null when they are not a JSON object. */
export function parseArgs(value: string): Record<string, unknown> | null {
  if (value.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Whether every check row can be sent (a tool and valid arguments). */
export const checksValid = (rows: CheckRow[]) => rows.every((r) => r.tool.trim() !== '' && parseArgs(r.args) !== null)

export function runSettingsBody(form: RunSettingsForm): RunSettingsBody {
  const minutes = whole(form.maxMinutes)
  const checks = form.checks.filter((r) => r.tool.trim() !== '')
  return {
    tool_allowlist: form.tools,
    max_tool_calls: whole(form.maxToolCalls),
    max_runtime_s: minutes == null ? null : minutes * 60,
    chat_retention_days: whole(form.retentionDays),
    contact_tools_allowed: form.contactsAllowed.split(',').map((s) => s.trim()).filter(Boolean),
    change_check: checks.length ? checks.map((r) => ({ tool: r.tool.trim(), args: parseArgs(r.args) ?? {} })) : null,
    run_anyway_hours: checks.length ? whole(form.runAnywayHours) : null,
    ...(form.stateNoteEdited ? { state_note: form.stateNote.trim() || null } : {}),
  }
}
