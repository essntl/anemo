import { describe, expect, it } from 'vitest'
import { MAIN, agentDurationMs, agentTree, agentsOf, eventsOfAgent, parentOf } from './agents'
import sample from './agents.fixture.json'
import { type CodeEvent, buildTimeline } from './timeline'

/**
 * `agents.fixture.json`: 20 events of a real orchestrator job (shortened, ids kept, no
 * secrets): the main agent starts two sub-agents in the background ("Set up local test
 * toolchain" and "B: Android voice mode"), each does a few tool calls, and a progress
 * report of each. Neither had ended when the sample was taken.
 */
const SAMPLE = sample as unknown as CodeEvent[]
const SETUP = 'toolu_01VsoTZBKwaqBXxfEzXgZkAr'
const VOICE = 'toolu_012dPMLFLMR8cG5UVa2zzbb4'

let seq = 1000
function ev(event: Record<string, unknown>): CodeEvent {
  seq += 1
  return { seq, kind: 'other', event, trimmed: false, dropped: false, created_at: '2026-11-24T12:00:00Z' }
}
const call = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null, timestamp?: string) =>
  ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: parent, ...(timestamp ? { timestamp } : {}) })
const result = (id: string, text: string, details?: Record<string, unknown>, isError = false, parent: string | null = null) =>
  ev({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] },
    parent_tool_use_id: parent, ...(details ? { tool_use_result: details } : {}),
  })

describe('agentsOf, on the real sample', () => {
  const agents = agentsOf(SAMPLE, true)

  it('finds both background sub-agents with their description and type', () => {
    expect(agents.map((a) => [a.id, a.description, a.type, a.background, a.parent, a.depth])).toEqual([
      [SETUP, 'Set up local test toolchain', 'general-purpose', true, MAIN, 1],
      [VOICE, 'B: Android voice mode', 'general-purpose', true, MAIN, 1],
    ])
  })

  it('keeps an async launch running (its end comes later) and takes time and calls from task_progress', () => {
    const setup = agents.find((a) => a.id === SETUP)!
    expect(setup.status).toBe('running')
    // The progress report counts every call (27), more than the 1 whose events are in the sample.
    expect(setup.toolCalls).toBe(27)
    expect(setup.durationMs).toBe(677_384)
    // Its start comes from the event's own timestamp, not from when the server stored it.
    expect(setup.startedAt).toBe('2026-11-24T10:58:24.202Z')
  })

  it('calls a sub-agent that never ended "stopped" once the job has ended', () => {
    expect(agentsOf(SAMPLE, false).map((a) => a.status)).toEqual(['stopped', 'stopped'])
  })

  it('splits the events by agent without losing or repeating one', () => {
    const main = eventsOfAgent(SAMPLE, agents, MAIN)
    const setup = eventsOfAgent(SAMPLE, agents, SETUP)
    const voice = eventsOfAgent(SAMPLE, agents, VOICE)
    expect(main.length + setup.length + voice.length).toBe(SAMPLE.length)
    expect(setup.length).toBe(4)
    expect(voice.length).toBe(4)
    expect(main.every((e) => parentOf(e) === undefined)).toBe(true)
    // The main agent's timeline holds the Agent calls (to link to), but none of their work.
    const items = buildTimeline(main)
    const agentCalls = items.flatMap((i) => (i.kind === 'tool' && i.call.name === 'Agent' ? [i.call] : []))
    expect(agentCalls.map((c) => c.id)).toEqual([SETUP, VOICE])
    expect(agentCalls.every((c) => c.children.length === 0)).toBe(true)
    // A sub-agent's own timeline starts at the top (its call isn't in its own events).
    const own = buildTimeline(setup)
    expect(own.some((i) => i.kind === 'tool' && i.call.name === 'Bash')).toBe(true)
  })
})

describe('agentsOf, how sub-agents end', () => {
  it('ends a background agent with its task_notification', () => {
    const events = [
      ...SAMPLE,
      ev({ type: 'system', subtype: 'task_notification', task_id: 'aa2619ad890ffc36b', tool_use_id: SETUP, status: 'completed', timestamp: '2026-11-24T11:20:00Z' }),
      ev({ type: 'system', subtype: 'task_notification', task_id: 'ae3b94e09cf7a0934', tool_use_id: VOICE, status: 'failed' }),
    ]
    const agents = agentsOf(events, true)
    expect(agents.map((a) => a.status)).toEqual(['done', 'failed'])
    expect(agents[0].endedAt).toBe('2026-11-24T11:20:00Z')
  })

  it('ends a background agent with a task_updated status found by its task id', () => {
    const events = [...SAMPLE, ev({ type: 'system', subtype: 'task_updated', task_id: 'aa2619ad890ffc36b', patch: { status: 'completed' } })]
    expect(agentsOf(events, true)[0].status).toBe('done')
  })

  it('ends a foreground Task with its tool_result, and reads nested sub-agents', () => {
    const events = [
      call('toolu_outer', 'Task', { description: 'Review the PR', prompt: 'Look at it\nand report', subagent_type: 'reviewer' }, null, '2026-11-24T12:00:00Z'),
      call('toolu_a', 'Read', { file_path: 'a.py' }, 'toolu_outer'),
      result('toolu_a', 'print(1)', undefined, false, 'toolu_outer'),
      call('toolu_inner', 'Task', { prompt: 'Check the tests\nin detail' }, 'toolu_outer'),
      call('toolu_b', 'Bash', { command: 'pytest' }, 'toolu_inner'),
      result('toolu_inner', 'Tests fail', { status: 'completed', totalDurationMs: 5000, totalToolUseCount: 1 }, true, 'toolu_outer'),
      result('toolu_outer', 'All good', { status: 'completed', agentId: 'x1', totalDurationMs: 42_000, totalToolUseCount: 3 }),
    ]
    const agents = agentsOf(events, false)
    expect(agents.map((a) => [a.id, a.parent, a.depth, a.status, a.toolCalls, a.durationMs])).toEqual([
      ['toolu_outer', MAIN, 1, 'done', 3, 42_000],
      ['toolu_inner', 'toolu_outer', 2, 'failed', 1, 5000],
    ])
    expect(agents[0].resultText).toBe('All good')
    // No description: the first line of the prompt.
    expect(agents[1].description).toBe('Check the tests')
    // Each event belongs to exactly one agent.
    expect(eventsOfAgent(events, agents, MAIN).map((e) => e.seq)).toEqual([events[0].seq, events[6].seq])
    expect(eventsOfAgent(events, agents, 'toolu_outer')).toHaveLength(4)
    expect(eventsOfAgent(events, agents, 'toolu_inner')).toHaveLength(1)
  })

  it('keeps events of an unknown parent (its call was not stored) with the main agent', () => {
    const orphan = call('toolu_c', 'Bash', { command: 'ls' }, 'toolu_gone')
    const events = [call('toolu_t', 'Task', { description: 'T' }), orphan]
    const agents = agentsOf(events, true)
    expect(eventsOfAgent(events, agents, MAIN)).toContain(orphan)
  })

  it('routes a stub (an event not stored) by the parent it kept', () => {
    const stub: CodeEvent = { ...ev({ type: 'assistant', parent_tool_use_id: SETUP }), dropped: true }
    const events = [...SAMPLE, stub]
    expect(eventsOfAgent(events, agentsOf(events, true), SETUP)).toContain(stub)
  })

  it('finds no agents in a job without Task calls', () => {
    expect(agentsOf([call('toolu_x', 'Bash', { command: 'ls' })], true)).toEqual([])
  })
})

describe('agentTree and agentDurationMs', () => {
  it('lists each agent before the agents it started', () => {
    const events = [
      call('t1', 'Task', { description: 'one' }),
      call('t2', 'Task', { description: 'two' }),
      call('t1a', 'Task', { description: 'one-a' }, 't1'),
    ]
    expect(agentTree(agentsOf(events, true)).map((a) => a.id)).toEqual(['t1', 't1a', 't2'])
  })

  it('counts a running agent up to now, and an ended one as reported', () => {
    const events = [call('t1', 'Task', { description: 'one' }, null, '2026-11-24T12:00:00Z')]
    const [running] = agentsOf(events, true)
    expect(agentDurationMs(running, Date.parse('2026-11-24T12:01:30Z'))).toBe(90_000)
    const ended = agentsOf([...events, result('t1', 'ok', { totalDurationMs: 1234 })], true)[0]
    expect(agentDurationMs(ended)).toBe(1234)
  })
})
