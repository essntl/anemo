import { describe, expect, it } from 'vitest'
import type { Automation } from './api'
import { checksValid, parseArgs, runSettingsBody, runSettingsFrom } from './runSettings'

const existing = (over: Partial<Automation> = {}) =>
  ({
    tool_allowlist: null, max_tool_calls: null, max_runtime_s: null, chat_retention_days: null,
    contact_tools_allowed: [], change_check: null, run_anyway_hours: null, state_note: null, ...over,
  }) as Automation

describe('run settings', () => {
  it('starts new automations with the limits new ones get, and keeps an existing one as it was', () => {
    expect(runSettingsBody(runSettingsFrom(null))).toEqual({
      tool_allowlist: null, max_tool_calls: 30, max_runtime_s: 300, chat_retention_days: null,
      contact_tools_allowed: [], change_check: null, run_anyway_hours: null, state_note: null,
    })
    // No settings of its own: none are added by opening and saving it.
    expect(runSettingsBody(runSettingsFrom(existing()))).toMatchObject({ max_tool_calls: null, max_runtime_s: null })
  })

  it('reads the settings back into the same form', () => {
    const a = existing({
      tool_allowlist: ['list_events', 'mcp__artemk__open_requests'], max_tool_calls: 12, max_runtime_s: 600,
      chat_retention_days: 7, contact_tools_allowed: ['send_sms', 'send_mail'], run_anyway_hours: 6,
      change_check: [{ tool: 'list_events', args: { date: 'today' } }], state_note: 'reminded about #12',
    })
    const form = runSettingsFrom(a)
    expect(form).toMatchObject({ maxMinutes: '10', retentionDays: '7', contactsAllowed: 'send_sms, send_mail' })
    expect(runSettingsBody(form)).toEqual({
      tool_allowlist: a.tool_allowlist, max_tool_calls: 12, max_runtime_s: 600, chat_retention_days: 7,
      contact_tools_allowed: ['send_sms', 'send_mail'], change_check: a.change_check, run_anyway_hours: 6,
      state_note: 'reminded about #12',
    })
  })

  it('checks the arguments of the change check', () => {
    expect(parseArgs('')).toEqual({})
    expect(parseArgs('{"date": "today"}')).toEqual({ date: 'today' })
    expect(parseArgs('[1]')).toBeNull()
    expect(parseArgs('{date')).toBeNull()
    expect(checksValid([{ tool: 'list_events', args: '{}' }])).toBe(true)
    expect(checksValid([{ tool: '', args: '{}' }])).toBe(false)
    // Without checks, "run anyway" means nothing and is not sent.
    const form = { ...runSettingsFrom(null), runAnywayHours: '6' }
    expect(runSettingsBody(form).run_anyway_hours).toBeNull()
  })
})
