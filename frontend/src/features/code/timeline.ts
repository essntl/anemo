/**
 * A Claude Code job's events as a timeline to draw. Pure: no React, no IO.
 *
 * The events are the lines Claude Code wrote with `--output-format stream-json
 * --verbose` (docs/device-contracts.md §7), as the server stored them
 * (docs/specs/code-sessions.md §5.2, §6): possibly trimmed, possibly replaced by a stub
 * once the job held 5 MB. Everything in them is untrusted and of no fixed shape, so
 * every field is read defensively: a missing or odd field never throws.
 *
 *   system/init                → a quiet line (model, folder)
 *   assistant text / thinking  → text, collapsed thinking
 *   assistant tool_use         → a tool call, paired with the user event's tool_result
 *                                of the same id (and its `tool_use_result` details)
 *   parent_tool_use_id = X     → nested under the Task/Agent call X
 *   raw                        → plain text; stored-as-stub events → one "not stored" run
 *   result                     → the result
 */
import type { Schemas } from '@/api/client'

export type CodeEvent = Schemas['CodeEventOut']

type Json = Record<string, unknown>

const obj = (v: unknown): Json | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
/** A number, also when it came as a string (a decimal from the server). */
export const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

// ---- Merging what arrives (the first fetch, the live stream, a fetch after a gap) ----

/**
 * Both lists as one, by seq, each seq once. A stored event never changes (the server
 * keeps the first copy), so one already held is kept, and when nothing is new the
 * same list comes back: no new render, and no new fetch from it.
 */
export function mergeEvents(have: readonly CodeEvent[], incoming: readonly CodeEvent[]): CodeEvent[] {
  const bySeq = new Map<number, CodeEvent>()
  for (const e of have) bySeq.set(e.seq, e)
  let added = false
  for (const e of incoming) {
    if (typeof e?.seq !== 'number' || bySeq.has(e.seq)) continue
    bySeq.set(e.seq, e)
    added = true
  }
  if (!added) return have as CodeEvent[]
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/** The highest seq such that every seq from 1 to it is there (0 when seq 1 is missing). */
export function contiguousSeq(events: readonly CodeEvent[]): number {
  let last = 0
  for (const e of events) {
    if (e.seq === last + 1) last = e.seq
    else if (e.seq > last + 1) break
  }
  return last
}

// ---- Todos ----

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export interface Todo {
  content: string
  status: TodoStatus
  activeForm?: string
}

/** A TodoWrite list (`input.todos`, or the job's `todos`), cleaned up. */
export function toTodos(raw: unknown): Todo[] {
  const out: Todo[] = []
  for (const item of arr(raw)) {
    const o = obj(item)
    const content = str(o?.content)?.trim()
    if (!o || !content) continue
    const status = o.status === 'completed' || o.status === 'in_progress' ? o.status : 'pending'
    const activeForm = str(o.activeForm)?.trim()
    out.push({ content, status, ...(activeForm ? { activeForm } : {}) })
  }
  return out
}

/** "3 / 7": how many of the todos are completed. */
export const todoProgress = (todos: readonly Todo[]): string => `${todos.filter((x) => x.status === 'completed').length} / ${todos.length}`

// ---- The timeline ----

export interface ToolResult {
  seq: number
  /** The text the model got back (text blocks joined). */
  text: string
  isError: boolean
  /** Claude Code's own details of the result (`tool_use_result`): stdout/stderr, a patch, … */
  data?: Json
  /** Image blocks in the result: never loaded, only counted. */
  images: number
  trimmed: boolean
}

export interface ToolCall {
  id: string
  name: string
  input: Json
  seq: number
  result?: ToolResult
  /** A Task/Agent call: the sub-agent's own events. */
  children: TimelineItem[]
  /** The call's event was trimmed (or only its stub was stored). */
  trimmed: boolean
}

export interface ResultInfo {
  subtype?: string
  isError: boolean
  text?: string
  numTurns?: number
  durationMs?: number
  costUsd?: number
}

interface Base {
  /** Unique within the timeline (one event can give several items). */
  key: string
  seq: number
  /** The event was trimmed (§6): something in it was cut. */
  trimmed: boolean
}

export type TimelineItem =
  | (Base & { kind: 'init'; model?: string; cwd?: string })
  | (Base & { kind: 'system'; subtype: string })
  | (Base & { kind: 'text'; text: string })
  | (Base & { kind: 'thinking'; text: string })
  /** A user message's own text: a sub-agent's prompt, "[Request interrupted by user]". */
  | (Base & { kind: 'user'; text: string })
  | (Base & { kind: 'tool'; call: ToolCall })
  | (Base & { kind: 'raw'; text: string })
  /** An event too large to keep, of which only its type is left (§6 step 4). */
  | (Base & { kind: 'too_large'; type: string })
  /** Events stored as stubs once the job held 5 MB: `count` of them, `seq`…`toSeq`. */
  | (Base & { kind: 'dropped'; toSeq: number; count: number })
  | (Base & { kind: 'result'; result: ResultInfo })
  /** An event of a type this page doesn't know. */
  | (Base & { kind: 'other'; type: string; event: Json })

type Dropped = Extract<TimelineItem, { kind: 'dropped' }>

/** The text of a tool_result's `content`: a string, or blocks of which the text ones count. */
function resultText(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 }
  const texts: string[] = []
  let images = 0
  for (const block of arr(content)) {
    const b = obj(block)
    if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b?.type === 'image') images += 1
  }
  return { text: texts.join('\n'), images }
}

/** A message's content blocks (a plain string is one text block). */
function blocksOf(event: Json): Json[] {
  const content = obj(event.message)?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return arr(content).map(obj).filter((b): b is Json => b !== undefined)
}

/** The timeline of one job's events (in any order; sorted by seq here). */
export function buildTimeline(events: readonly CodeEvent[]): TimelineItem[] {
  const top: TimelineItem[] = []
  const calls = new Map<string, ToolCall>()
  let dropped: Dropped | null = null

  for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
    const seq = ev.seq
    const trimmed = Boolean(ev.trimmed)
    if (ev.dropped) {
      // Stubs one after another collapse into one notice.
      if (dropped && dropped.toSeq < seq) {
        dropped.toSeq = seq
        dropped.count += 1
      } else {
        dropped = { kind: 'dropped', key: `${seq}`, seq, toSeq: seq, count: 1, trimmed: false }
        top.push(dropped)
      }
      continue
    }
    dropped = null

    const e = obj(ev.event) ?? {}
    const type = str(e.type) ?? ''
    const parent = str(e.parent_tool_use_id)
    // A sub-agent's events go inside its Task call (at the top when that call isn't known).
    const into = (parent && calls.get(parent)?.children) || top
    const tooLarge = e.anemo_trimmed !== undefined
    let index = 0
    const key = () => `${seq}:${index++}`
    const before = into.length

    switch (type) {
      case 'system': {
        const subtype = str(e.subtype) ?? ''
        if (subtype === 'init') into.push({ kind: 'init', key: key(), seq, trimmed, model: str(e.model), cwd: str(e.cwd) })
        else into.push({ kind: 'system', key: key(), seq, trimmed, subtype })
        break
      }
      case 'assistant': {
        for (const b of blocksOf(e)) {
          if (b.type === 'text') {
            const text = str(b.text) ?? ''
            if (text.trim()) into.push({ kind: 'text', key: key(), seq, trimmed, text })
          } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
            into.push({ kind: 'thinking', key: key(), seq, trimmed, text: str(b.thinking) ?? '' })
          } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
            const id = str(b.id) ?? `${seq}:${index}`
            const call: ToolCall = { id, name: str(b.name) ?? '', input: obj(b.input) ?? {}, seq, children: [], trimmed }
            calls.set(id, call)
            into.push({ kind: 'tool', key: key(), seq, trimmed, call })
          }
        }
        break
      }
      case 'user': {
        const blocks = blocksOf(e)
        const results = blocks.filter((b) => b.type === 'tool_result')
        for (const b of blocks) {
          if (b.type === 'tool_result') {
            const { text, images } = resultText(b.content)
            const result: ToolResult = {
              seq, text, images, trimmed, isError: b.is_error === true,
              // The details belong to the one result of the event (that is how Claude Code writes them).
              data: results.length === 1 ? obj(e.tool_use_result) : undefined,
            }
            const id = str(b.tool_use_id) ?? ''
            const call = calls.get(id)
            if (call) {
              call.result = result
              call.trimmed ||= trimmed
            } else {
              // Its call isn't here (not stored, or trimmed away): shown on its own.
              into.push({ kind: 'tool', key: key(), seq, trimmed, call: { id: id || `${seq}:${index}`, name: '', input: {}, seq, children: [], trimmed, result } })
            }
          } else if (b.type === 'text') {
            const text = str(b.text) ?? ''
            if (text.trim()) into.push({ kind: 'user', key: key(), seq, trimmed, text })
          }
        }
        break
      }
      case 'result':
        top.push({
          kind: 'result', key: key(), seq, trimmed,
          result: {
            subtype: str(e.subtype),
            isError: e.is_error === true,
            text: str(e.result),
            numTurns: num(e.num_turns),
            durationMs: num(e.duration_ms),
            costUsd: num(e.total_cost_usd),
          },
        })
        break
      case 'raw':
        into.push({ kind: 'raw', key: key(), seq, trimmed, text: str(e.text) ?? '' })
        break
      default:
        if (!tooLarge) into.push({ kind: 'other', key: key(), seq, trimmed, type: type || '?', event: e })
    }
    // A stub with nothing left to show still says something was there.
    if (tooLarge && into.length === before && type !== 'result') into.push({ kind: 'too_large', key: key(), seq, trimmed: true, type: type || '?' })
  }
  return top
}

/** The result of a timeline, if it has one. */
export function resultOf(items: readonly TimelineItem[]): ResultInfo | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'result') return item.result
  }
  return undefined
}

// ---- Reading a tool call ----

export const TASK_TOOLS = ['Task', 'Agent']
export const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']

/** The file a call is about. */
export function pathOf(call: ToolCall): string | undefined {
  const i = call.input
  return str(i.file_path) ?? str(i.notebook_path) ?? str(call.result?.data?.filePath) ?? str(obj(call.result?.data?.file)?.filePath)
}

/** One line that says what the call is about: the command, the path, the pattern, … */
export function subjectOf(call: ToolCall): string {
  const i = call.input
  const firstLine = (s: string | undefined) => (s ?? '').split('\n').find((l) => l.trim())?.trim() ?? ''
  switch (call.name) {
    case 'Bash':
      return firstLine(str(i.command))
    case 'Grep':
    case 'Glob': {
      const pattern = str(i.pattern) ?? ''
      const where = str(i.path) ?? str(i.glob)
      return where ? `${pattern}  ·  ${where}` : pattern
    }
    case 'WebFetch':
      return str(i.url) ?? ''
    case 'WebSearch':
      return str(i.query) ?? ''
    case 'Task':
    case 'Agent':
      return firstLine(str(i.description) ?? str(i.prompt))
    case 'TodoWrite':
      return ''
    default: {
      const path = pathOf(call)
      if (path) return path
      // Another tool (an MCP one): its first short text argument.
      const first = Object.values(i).find((v): v is string => typeof v === 'string' && v.trim() !== '')
      return firstLine(first).slice(0, 200)
    }
  }
}

/** The lines a Read call read: "from–to" and of how many, when known. */
export function readRange(call: ToolCall): { from: number; to: number; total?: number } | undefined {
  const file = obj(call.result?.data?.file)
  const start = num(file?.startLine) ?? num(call.input.offset)
  const count = num(file?.numLines) ?? num(call.input.limit)
  if (start === undefined || count === undefined || count <= 0) return undefined
  return { from: start, to: start + count - 1, total: num(file?.totalLines) }
}

/** A shell call's output, as Claude Code reported it (stdout and stderr apart). */
export function shellOutput(call: ToolCall): { stdout: string; stderr: string; interrupted: boolean } | undefined {
  const d = call.result?.data
  if (!d || (typeof d.stdout !== 'string' && typeof d.stderr !== 'string')) return undefined
  return { stdout: str(d.stdout) ?? '', stderr: str(d.stderr) ?? '', interrupted: d.interrupted === true }
}

// ---- Diffs ----

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'note'
  text: string
}
export interface FileDiff {
  lines: DiffLine[]
  added: number
  removed: number
}

const splitLines = (s: string): string[] => {
  const lines = s.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function finish(lines: DiffLine[]): FileDiff {
  return { lines, added: lines.filter((l) => l.kind === 'add').length, removed: lines.filter((l) => l.kind === 'del').length }
}

/** `tool_use_result.structuredPatch`: hunks of `lines` that start with " ", "-" or "+". */
function fromPatch(hunks: unknown[]): DiffLine[] {
  const out: DiffLine[] = []
  for (const hunk of hunks) {
    const h = obj(hunk)
    if (!h) continue
    const n = (v: unknown) => num(v) ?? 0
    out.push({ kind: 'hunk', text: `@@ -${n(h.oldStart)},${n(h.oldLines)} +${n(h.newStart)},${n(h.newLines)} @@` })
    for (const raw of arr(h.lines)) {
      if (typeof raw !== 'string') continue
      const mark = raw[0]
      if (mark === '+') out.push({ kind: 'add', text: raw.slice(1) })
      else if (mark === '-') out.push({ kind: 'del', text: raw.slice(1) })
      else if (mark === '\\') out.push({ kind: 'note', text: raw })
      else out.push({ kind: 'ctx', text: mark === ' ' ? raw.slice(1) : raw })
    }
  }
  return out
}

/** The old text replaced by the new one: the lines they share at both ends as context. */
function fromStrings(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : splitLines(before)
  const b = after === '' ? [] : splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  return [
    ...a.slice(0, start).map((text) => ({ kind: 'ctx' as const, text })),
    ...a.slice(start, a.length - end).map((text) => ({ kind: 'del' as const, text })),
    ...b.slice(start, b.length - end).map((text) => ({ kind: 'add' as const, text })),
    ...a.slice(a.length - end).map((text) => ({ kind: 'ctx' as const, text })),
  ]
}

/**
 * What an Edit, MultiEdit or Write call changed: from Claude Code's patch when the
 * result has one, else from the call's old and new strings, else the written content.
 */
export function diffOf(call: ToolCall): FileDiff | undefined {
  if (!EDIT_TOOLS.includes(call.name)) return undefined
  const data = call.result?.data
  const patch = arr(data?.structuredPatch)
  if (patch.length > 0) {
    const lines = fromPatch(patch)
    if (lines.length > 0) return finish(lines)
  }
  const i = call.input
  if (call.name === 'Edit' || call.name === 'NotebookEdit') {
    const before = str(i.old_string) ?? str(data?.oldString) ?? ''
    const after = str(i.new_string) ?? str(i.new_source) ?? str(data?.newString) ?? ''
    if (before || after) return finish(fromStrings(before, after))
    return undefined
  }
  if (call.name === 'MultiEdit') {
    const lines: DiffLine[] = []
    const edits = arr(i.edits).map(obj).filter((e): e is Json => e !== undefined)
    edits.forEach((e, n) => {
      if (edits.length > 1) lines.push({ kind: 'hunk', text: `@@ ${n + 1} / ${edits.length} @@` })
      lines.push(...fromStrings(str(e.old_string) ?? '', str(e.new_string) ?? ''))
    })
    return lines.length ? finish(lines) : undefined
  }
  // Write: the whole content is new.
  const content = str(i.content) ?? str(data?.content)
  return content ? finish(splitLines(content).map((text) => ({ kind: 'add', text }))) : undefined
}
