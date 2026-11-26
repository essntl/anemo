import { describe, expect, it } from 'vitest'
import {
  type CodeEvent, type TimelineItem, type ToolCall, buildTimeline, contiguousSeq, diffOf, mergeEvents, readRange, resultOf, shellOutput,
  subjectOf, todoProgress, toTodos,
} from './timeline'

let at = 0
/** An event as the server stores it. */
function ev(event: Record<string, unknown>, more: Partial<CodeEvent> = {}): CodeEvent {
  at += 1
  return {
    seq: at, kind: (['system', 'assistant', 'user', 'result', 'raw'].includes(String(event.type)) ? event.type : 'other') as CodeEvent['kind'],
    event, trimmed: false, dropped: false, created_at: '2026-11-23T10:15:00Z', ...more,
  }
}
const SESSION = 'b5f8c1e2-1111-4c3e-9a77-0d9b1d2f3a4b'
const assistant = (content: unknown[], parent: string | null = null) =>
  ev({ type: 'assistant', message: { id: `msg_${at}`, role: 'assistant', model: 'claude-opus-4-1', content }, parent_tool_use_id: parent, session_id: SESSION })
const toolUse = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null) =>
  assistant([{ type: 'tool_use', id, name, input }], parent)
const toolResult = (id: string, content: unknown, toolUseResult?: unknown, isError = false, parent: string | null = null) =>
  ev({
    type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
    parent_tool_use_id: parent, session_id: SESSION, ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }),
  })

const tools = (items: TimelineItem[]): ToolCall[] => items.flatMap((i) => (i.kind === 'tool' ? [i.call] : []))
const call = (items: TimelineItem[], name: string): ToolCall => tools(items).find((c) => c.name === name)!

/** A realistic job: Claude Code's stream-json, as written with --verbose. */
function job(): CodeEvent[] {
  at = 0
  return [
    ev({ type: 'system', subtype: 'init', cwd: 'C:\\dev\\anemo', session_id: SESSION, tools: ['Bash', 'Edit'], model: 'claude-opus-4-1', permissionMode: 'bypassPermissions' }),
    assistant([{ type: 'thinking', thinking: 'The user wants the version bumped.', signature: 'sig' }]),
    assistant([{ type: 'text', text: "I'll look at the **package** first." }]),
    toolUse('toolu_bash1', 'Bash', { command: 'git status --short\ngit log -1', description: 'Show the working tree' }),
    toolResult('toolu_bash1', ' M package.json', { stdout: ' M package.json', stderr: '', interrupted: false, isImage: false }),
    toolUse('toolu_bash2', 'Bash', { command: 'npm test' }),
    toolResult('toolu_bash2', 'Error: 2 tests failed', { stdout: 'ran 10 tests', stderr: '2 failed', interrupted: false }, true),
    toolUse('toolu_read', 'Read', { file_path: 'C:\\dev\\anemo\\package.json' }),
    toolResult('toolu_read', '     1\t{\n     2\t  "name": "anemo"', { type: 'text', file: { filePath: 'C:\\dev\\anemo\\package.json', numLines: 40, startLine: 1, totalLines: 120 } }),
    toolUse('toolu_edit', 'Edit', { file_path: 'C:\\dev\\anemo\\package.json', old_string: '"version": "1.0.0"', new_string: '"version": "1.1.0"' }),
    toolResult('toolu_edit', 'The file has been updated.', {
      filePath: 'C:\\dev\\anemo\\package.json', oldString: '"version": "1.0.0"', newString: '"version": "1.1.0"',
      structuredPatch: [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 3, lines: ['   "name": "anemo",', '-  "version": "1.0.0",', '+  "version": "1.1.0",', '   "private": true'] }],
      userModified: false, replaceAll: false,
    }),
    toolUse('toolu_write', 'Write', { file_path: 'C:\\dev\\anemo\\NOTES.md', content: '# Notes\n\nBumped.\n' }),
    toolResult('toolu_write', 'File created successfully', { type: 'create', filePath: 'C:\\dev\\anemo\\NOTES.md', structuredPatch: [] }),
    toolUse('toolu_grep', 'Grep', { pattern: 'version', path: 'src', output_mode: 'files_with_matches' }),
    toolResult('toolu_grep', 'Found 2 files\nsrc/a.ts\nsrc/b.ts'),
    toolUse('toolu_todo', 'TodoWrite', { todos: [
      { content: 'Bump the version', status: 'completed', activeForm: 'Bumping the version' },
      { content: 'Run the tests', status: 'in_progress', activeForm: 'Running the tests' },
      { content: 'Open a PR', status: 'pending', activeForm: 'Opening a PR' },
    ] }),
    toolResult('toolu_todo', 'Todos have been modified successfully.'),
    toolUse('toolu_task', 'Task', { description: 'Check the changelog', prompt: 'Look at CHANGELOG.md and say what is missing.', subagent_type: 'general-purpose' }),
    ev({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Look at CHANGELOG.md and say what is missing.' }] }, parent_tool_use_id: 'toolu_task', session_id: SESSION }),
    toolUse('toolu_sub_read', 'Read', { file_path: 'CHANGELOG.md' }, 'toolu_task'),
    toolResult('toolu_sub_read', '1\t# Changelog', undefined, false, 'toolu_task'),
    assistant([{ type: 'text', text: 'The 1.1.0 entry is missing.' }], 'toolu_task'),
    toolResult('toolu_task', [{ type: 'text', text: 'The 1.1.0 entry is missing.' }]),
    ev({ type: 'raw', text: 'not json at all' }),
    toolUse('toolu_pending', 'Bash', { command: 'gh pr create --fill' }),
  ]
}

describe('buildTimeline', () => {
  it('turns a job into items, in order', () => {
    const items = buildTimeline(job())
    expect(items.map((i) => i.kind)).toEqual([
      'init', 'thinking', 'text', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'raw', 'tool',
    ])
    expect(items[0]).toMatchObject({ kind: 'init', model: 'claude-opus-4-1', cwd: 'C:\\dev\\anemo' })
    expect(items[1]).toMatchObject({ kind: 'thinking', text: 'The user wants the version bumped.' })
    expect(items[2]).toMatchObject({ kind: 'text', text: "I'll look at the **package** first." })
    expect(items.find((i) => i.kind === 'raw')).toMatchObject({ text: 'not json at all' })
    // Keys are unique, for React.
    const keys = items.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('pairs a Bash call with its output, and an error result', () => {
    const items = buildTimeline(job())
    const [ok, failed] = tools(items).filter((c) => c.name === 'Bash')
    expect(subjectOf(ok)).toBe('git status --short')
    expect(shellOutput(ok)).toEqual({ stdout: ' M package.json', stderr: '', interrupted: false })
    expect(ok.result?.isError).toBe(false)
    expect(failed.result).toMatchObject({ isError: true, text: 'Error: 2 tests failed' })
    expect(shellOutput(failed)?.stderr).toBe('2 failed')
  })

  it('reads the diff of an Edit from structuredPatch', () => {
    const edit = call(buildTimeline(job()), 'Edit')
    const diff = diffOf(edit)!
    expect(diff.lines).toEqual([
      { kind: 'hunk', text: '@@ -2,3 +2,3 @@' },
      { kind: 'ctx', text: '  "name": "anemo",' },
      { kind: 'del', text: '  "version": "1.0.0",' },
      { kind: 'add', text: '  "version": "1.1.0",' },
      { kind: 'ctx', text: '  "private": true' },
    ])
    expect([diff.added, diff.removed]).toEqual([1, 1])
    expect(subjectOf(edit)).toBe('C:\\dev\\anemo\\package.json')
  })

  it('falls back to the old and new strings when there is no patch (yet)', () => {
    at = 0
    const items = buildTimeline([toolUse('e1', 'Edit', { file_path: 'a.ts', old_string: 'const a = 1\nconst b = 2\nconst c = 3', new_string: 'const a = 1\nconst b = 20\nconst c = 3' })])
    expect(diffOf(call(items, 'Edit'))?.lines).toEqual([
      { kind: 'ctx', text: 'const a = 1' }, { kind: 'del', text: 'const b = 2' }, { kind: 'add', text: 'const b = 20' }, { kind: 'ctx', text: 'const c = 3' },
    ])
  })

  it('shows what a Write created, and the lines a Read read', () => {
    const items = buildTimeline(job())
    expect(diffOf(call(items, 'Write'))?.lines).toEqual([
      { kind: 'add', text: '# Notes' }, { kind: 'add', text: '' }, { kind: 'add', text: 'Bumped.' },
    ])
    const read = call(items, 'Read')
    expect(readRange(read)).toEqual({ from: 1, to: 40, total: 120 })
    expect(read.result?.text).toContain('"name": "anemo"')
  })

  it('reads Grep and TodoWrite calls', () => {
    const items = buildTimeline(job())
    expect(subjectOf(call(items, 'Grep'))).toBe('version  ·  src')
    const todos = toTodos(call(items, 'TodoWrite').input.todos)
    expect(todos.map((t) => t.status)).toEqual(['completed', 'in_progress', 'pending'])
    expect(todos[1].activeForm).toBe('Running the tests')
    expect(todoProgress(todos)).toBe('1 / 3')
  })

  it('nests a sub-agent’s events under its Task call', () => {
    const items = buildTimeline(job())
    const task = call(items, 'Task')
    expect(subjectOf(task)).toBe('Check the changelog')
    expect(task.children.map((c) => c.kind)).toEqual(['user', 'tool', 'text'])
    const inner = tools(task.children)[0]
    expect(inner).toMatchObject({ name: 'Read', result: { text: '1\t# Changelog' } })
    expect(task.result?.text).toBe('The 1.1.0 entry is missing.')
    // Nothing of the sub-agent at the top.
    expect(tools(items).some((c) => c.id === 'toolu_sub_read')).toBe(false)
  })

  it('leaves a call without a result yet open', () => {
    const items = buildTimeline(job())
    const last = tools(items).at(-1)!
    expect(last).toMatchObject({ id: 'toolu_pending', name: 'Bash' })
    expect(last.result).toBeUndefined()
  })

  it('takes the events in any order', () => {
    const events = job()
    const shuffled = [...events].reverse()
    expect(buildTimeline(shuffled)).toEqual(buildTimeline(events))
  })

  it('marks trimmed events and shows what is left of one too large to keep', () => {
    at = 0
    const items = buildTimeline([
      ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'long…' }] } }, { trimmed: true }),
      ev({ type: 'assistant', anemo_trimmed: 'too large', message: { content: [{ type: 'tool_use', name: 'Write', id: 'w1' }] } }, { trimmed: true }),
      ev({ type: 'user', anemo_trimmed: 'too large' }, { trimmed: true }),
    ])
    expect(items[0]).toMatchObject({ kind: 'text', trimmed: true })
    expect(items[1]).toMatchObject({ kind: 'tool', call: { id: 'w1', name: 'Write', input: {}, trimmed: true } })
    expect(items[2]).toMatchObject({ kind: 'too_large', type: 'user', trimmed: true })
  })

  it('collapses events that were not stored into one notice per run', () => {
    at = 0
    const stub = (type: string) => ev({ type }, { dropped: true })
    const items = buildTimeline([
      ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'before' }] } }),
      stub('assistant'), stub('user'), stub('assistant'),
      toolUse('t1', 'TodoWrite', { todos: [] }),
      stub('user'),
    ])
    expect(items.map((i) => i.kind)).toEqual(['text', 'dropped', 'tool', 'dropped'])
    expect(items[1]).toMatchObject({ seq: 2, toSeq: 4, count: 3 })
    expect(items[3]).toMatchObject({ seq: 6, toSeq: 6, count: 1 })
  })

  it('reads a successful result and a failed one', () => {
    at = 0
    const ok = buildTimeline([ev({ type: 'result', subtype: 'success', is_error: false, duration_ms: 125000, num_turns: 14, result: 'Done: **1.1.0**', total_cost_usd: 1.2345, session_id: SESSION })])
    expect(resultOf(ok)).toEqual({ subtype: 'success', isError: false, text: 'Done: **1.1.0**', numTurns: 14, durationMs: 125000, costUsd: 1.2345 })
    const failed = buildTimeline([ev({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 50, total_cost_usd: '3.5' })])
    expect(resultOf(failed)).toMatchObject({ subtype: 'error_max_turns', isError: true, costUsd: 3.5, text: undefined })
  })

  it('survives events of odd shapes', () => {
    at = 0
    const items = buildTimeline([
      ev({}),
      ev({ type: 'assistant' }),
      ev({ type: 'assistant', message: { content: 'plain string content' } }),
      ev({ type: 'assistant', message: { content: [null, 3, { type: 'tool_use' }] } }),
      ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'nobody', content: [{ type: 'image', source: {} }] }] } }),
      ev({ type: 'stream_event', event: { type: 'content_block_delta' } }),
      ev({ type: 'system', subtype: 'compact_boundary' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['other', 'text', 'tool', 'tool', 'other', 'system'])
    const orphan = tools(items)[1]
    expect(orphan).toMatchObject({ id: 'nobody', name: '', result: { text: '', images: 1 } })
  })
})

describe('merging events', () => {
  const e = (seq: number, text = String(seq)): CodeEvent => ({ seq, kind: 'raw', event: { type: 'raw', text }, trimmed: false, dropped: false, created_at: '' })

  it('merges by seq, each once, in order', () => {
    const merged = mergeEvents([e(1), e(2), e(4)], [e(3), e(4, 'again'), e(5)])
    expect(merged.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5])
    // A stored event never changes: the copy held stays.
    expect(merged[3].event.text).toBe('4')
  })

  it('gives the same list back when nothing is new', () => {
    const have = [e(1), e(2), e(5)]
    expect(mergeEvents(have, [])).toBe(have)
    expect(mergeEvents(have, [e(5, 'again'), e(2)])).toBe(have)
  })

  it('knows the last seq without a gap', () => {
    expect(contiguousSeq([])).toBe(0)
    expect(contiguousSeq([e(1), e(2), e(3)])).toBe(3)
    expect(contiguousSeq([e(1), e(2), e(5), e(6)])).toBe(2)
    expect(contiguousSeq([e(2)])).toBe(0)
  })
})

describe('toTodos', () => {
  it('cleans up a list of any shape', () => {
    expect(toTodos(null)).toEqual([])
    expect(toTodos([{ content: ' A ', status: 'weird' }, { status: 'completed' }, 'x', { content: 'B', status: 'completed', activeForm: '' }])).toEqual([
      { content: 'A', status: 'pending' },
      { content: 'B', status: 'completed' },
    ])
  })
})

describe('bookkeeping events', () => {
  it('leaves rate_limit_event out of the timeline, also between stubs', () => {
    at = 0
    const limit = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1795435800 } }
    const items = buildTimeline([
      assistant([{ type: 'text', text: 'Working.' }]),
      ev(limit),
      ev({ type: 'assistant' }, { dropped: true }),
      ev(limit),
      ev({ type: 'user' }, { dropped: true }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['text', 'dropped'])
    const dropped = items[1]
    expect(dropped.kind === 'dropped' && dropped.count).toBe(2)
  })

  it('leaves tool_progress out, also inside a sub-agent', () => {
    at = 0
    const progress = (parent: string | null) =>
      ev({ type: 'tool_progress', tool_use_id: 'toolu_task', tool_name: 'Task', parent_tool_use_id: parent, elapsed_time_seconds: 3 })
    const items = buildTimeline([
      toolUse('toolu_task', 'Task', { description: 'Look around', prompt: 'Look.' }),
      progress(null), progress(null),
      toolUse('toolu_sub', 'Bash', { command: 'ls' }, 'toolu_task'),
      progress('toolu_task'),
      ev({ type: 'tool_progress', anemo_trimmed: 'too large' }, { trimmed: true }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['tool'])
    expect(call(items, 'Task').children.map((c) => c.kind)).toEqual(['tool'])
  })
})

describe('messages sent while the job ran (§15)', () => {
  it('shows each message where Claude Code took it in, but not the prompt’s own echo', () => {
    at = 0
    const replay = (text: string, uuid: string) => ev({ type: 'user', message: { role: 'user', content: text }, isReplay: true, uuid }, { created_at: '2026-11-26T10:05:00Z' })
    const items = buildTimeline([
      ev({ type: 'command_lifecycle', command_uuid: 'x', state: 'queued' }),
      replay('Fix the login bug', 'p'),
      toolUse('toolu_1', 'Bash', { command: 'sleep 15' }),
      ev({ type: 'control_response', response: { subtype: 'success', request_id: 'interrupt-1' } }),
      toolResult('toolu_1', 'done'),
      replay('Also update the docs.', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'),
      assistant([{ type: 'text', text: 'Updating the docs.' }]),
    ])
    expect(items.map((i) => i.kind)).toEqual(['tool', 'message', 'text'])
    const message = items[1]
    expect(message.kind === 'message' && [message.text, message.at]).toEqual(['Also update the docs.', '2026-11-26T10:05:00Z'])
  })
})

