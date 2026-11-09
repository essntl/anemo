import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFERENCES, withDefaults } from '@/shared/preferences'
import { agentRunWorthNotifying, catchUp, dispose, eventTime, fromApprovalRequested, fromStoredNotification, summarize, type Spec } from './notify'

const NOW = Date.parse('2026-11-09T12:00:00Z')

describe('fromStoredNotification', () => {
  it('maps Anemo’s kinds and links to types and targets', () => {
    expect(fromStoredNotification({ id: '1', title: 'Reminder: Lecture', kind: 'reminder', link: '/calendar' }, NOW)).toMatchObject({ type: 'calendar', urgent: true, target: { kind: 'anemo', path: '/calendar' } })
    expect(fromStoredNotification({ id: '2', title: 'Due: essay', kind: 'reminder', link: '/tasks?task=abc' }, NOW)).toMatchObject({ type: 'reminder', target: { kind: 'anemo', path: '/tasks?task=abc' } })
    expect(fromStoredNotification({ id: '3', title: 'Daily digest', kind: 'automation', link: '/c/0192aabb-cc' }, NOW)).toMatchObject({ type: 'agent', urgent: false, target: { kind: 'chat', conversationId: '0192aabb-cc' } })
    expect(fromStoredNotification({ id: '4', title: 'x', kind: 'something-new' }, NOW)).toBeNull()
  })

  it('gives an agent question the same id as the live approval of that chat (one notification)', () => {
    const stored = fromStoredNotification({ id: '5', title: 'The agent has a question', kind: 'approval', link: '/c/0192aabb-cc' }, NOW)!
    const live = fromApprovalRequested({ run_id: 'r', conversation_id: '0192aabb-cc' }, 'Which folder?', NOW)
    expect(stored.id).toBe(live.id)
    expect(live.target).toEqual({ kind: 'chat', conversationId: '0192aabb-cc' })
  })

  it('never puts a whole text in a notification', () => {
    const spec = fromStoredNotification({ id: '6', title: 'x', body: 'word '.repeat(200), kind: 'agent' }, NOW)!
    expect(spec.message.length).toBeLessThanOrEqual(200)
  })

  it('refuses links that leave Anemo', () => {
    expect(fromStoredNotification({ id: '7', title: 'x', kind: 'agent', link: '//evil.example/x' }, NOW)?.target).toEqual({ kind: 'none' })
    expect(fromStoredNotification({ id: '8', title: 'x', kind: 'agent', link: 'https://evil.example' }, NOW)?.target).toEqual({ kind: 'none' })
  })
})

describe('agentRunWorthNotifying', () => {
  const run = { run_id: 'r', status: 'completed', conversation_id: 'c1', kind: 'agent' }
  it('notifies for long runs, or when the chat isn’t in view', () => {
    expect(agentRunWorthNotifying(run, 3 * 60_000, 'c1')).toBe(true)
    expect(agentRunWorthNotifying(run, 30_000, 'other')).toBe(true)
    expect(agentRunWorthNotifying(run, 30_000, null)).toBe(true)
    expect(agentRunWorthNotifying(run, 30_000, 'c1')).toBe(false)
  })
  it('ignores chat answers, sub-agents, automations and cancelled runs', () => {
    expect(agentRunWorthNotifying({ ...run, kind: 'chat' }, 1e6, null)).toBe(false)
    expect(agentRunWorthNotifying({ ...run, subagent: true }, 1e6, null)).toBe(false)
    expect(agentRunWorthNotifying({ ...run, automation: true }, 1e6, null)).toBe(false)
    expect(agentRunWorthNotifying({ ...run, status: 'cancelled' }, 1e6, null)).toBe(false)
  })
})

describe('dispose', () => {
  const spec = (type: Spec['type'], urgent = false): Spec => ({ id: type, type, title: 't', message: '', target: { kind: 'none' }, urgent, at: NOW })
  it('drops what is switched off', () => {
    const prefs = withDefaults({ notificationTypes: { ...DEFAULT_PREFERENCES.notificationTypes, agent: false } })
    expect(dispose(spec('agent'), prefs, false)).toBe('drop')
    expect(dispose(spec('reminder', true), withDefaults({ features: { ...DEFAULT_PREFERENCES.features, notifications: false } }), false)).toBe('drop')
  })
  it('holds only non-urgent ones during focus', () => {
    expect(dispose(spec('agent'), DEFAULT_PREFERENCES, true)).toBe('hold')
    expect(dispose(spec('approval', true), DEFAULT_PREFERENCES, true)).toBe('show')
    expect(dispose(spec('reminder', true), DEFAULT_PREFERENCES, true)).toBe('show')
    expect(dispose(spec('agent'), DEFAULT_PREFERENCES, false)).toBe('show')
  })
})

describe('catching up', () => {
  const mk = (id: string, at: number, type: Spec['type'] = 'reminder'): Spec => ({ id, type, title: id, message: '', target: { kind: 'none' }, urgent: true, at })
  it('keeps the last 24 hours, newest last, one per id', () => {
    const out = catchUp([mk('b', NOW - 1000), mk('old', NOW - 25 * 3600_000), mk('a', NOW - 2000), mk('b', NOW - 500)], NOW)
    expect(out.map((s) => s.id)).toEqual(['a', 'b'])
  })
  it('turns more than three into one summary', () => {
    const out = catchUp([mk('1', NOW), mk('2', NOW), mk('3', NOW, 'approval'), mk('4', NOW, 'agent')], NOW)
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('4 notifications while you were away')
    expect(out[0].message).toBe('2 reminders, 1 approval request, 1 agent result')
    expect(out[0].target).toEqual({ kind: 'anemo', path: '/notifications' })
  })
  it('summarises what focus held back', () => {
    expect(summarize([mk('1', NOW, 'agent'), mk('2', NOW, 'agent')], 'held', NOW).title).toBe('2 notifications during focus')
  })
})

describe('eventTime', () => {
  it('reads the time in a stream id', () => {
    expect(eventTime('1762689600000-3', NOW)).toBe(1762689600000)
    expect(eventTime('garbage', NOW)).toBe(NOW)
    expect(eventTime(null, NOW)).toBe(NOW)
  })
})
