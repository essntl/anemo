/**
 * The sub-agents of a Claude Code job, read from its events. Pure: no React, no IO.
 *
 * A job's main agent (the "orchestrator") starts a sub-agent with a `Task` or `Agent`
 * tool call. Every event the sub-agent then writes carries `parent_tool_use_id` = the id
 * of that call, so a job's events split cleanly into one list per agent. A sub-agent can
 * start sub-agents of its own: their events carry the id of *their* call, which was made
 * inside the outer sub-agent, so the agents form a tree.
 *
 * How a sub-agent ends depends on how it was started:
 *  - in the foreground: the call's `tool_result` comes when it is done (`is_error` when
 *    it failed), with `tool_use_result.totalDurationMs` / `totalToolUseCount`;
 *  - in the background (`run_in_background`): the `tool_result` comes at once and says
 *    `status: "async_launched"`; the end is a `system/task_notification` event with the
 *    call's `tool_use_id` and a `status` ("completed", "failed", …).
 * While it runs, `system/task_progress` events (same `tool_use_id`) report its time and
 * tool calls so far. A sub-agent still not ended when the job has ended is "stopped".
 *
 * Every field is read defensively: events are untrusted and may be trimmed or stubs.
 */
import { type CodeEvent, TASK_TOOLS, num } from './timeline'

/** The main agent's key in the URL (`?agent=`) and in the lists: never a tool call id. */
export const MAIN = 'main'

export type AgentStatus = 'running' | 'done' | 'failed' | 'stopped'

export interface AgentInfo {
  /** The id of the Task/Agent call that started it. */
  id: string
  /** The agent it was started in: MAIN, or another sub-agent's id. */
  parent: string
  /** 1 for a sub-agent of the main agent, 2 for one of those's, … */
  depth: number
  /** The call's `description` (else the first line of its prompt). */
  description: string
  prompt: string
  /** `subagent_type`, e.g. "general-purpose". */
  type?: string
  status: AgentStatus
  /** Started with `run_in_background`. */
  background: boolean
  /** Its own tool calls (not those of its sub-agents). */
  toolCalls: number
  /** As Claude Code reported it, when it did. */
  durationMs?: number
  /** When the call was made and when it ended (ISO times), for a duration Claude Code didn't report. */
  startedAt?: string
  endedAt?: string
  /** The seq of the event with the call. */
  seq: number
  /** The text it answered with (a foreground sub-agent's tool result). */
  resultText?: string
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** The parent call id of an event (a sub-agent's event), or undefined for the main agent's. */
export const parentOf = (ev: CodeEvent): string | undefined => str(obj(ev.event)?.parent_tool_use_id)

/** When the event was written: its own `timestamp` if it has one, else when the server stored it. */
const timeOf = (ev: CodeEvent, e: Json): string | undefined => str(e.timestamp) ?? str(ev.created_at)

function blocks(e: Json): Json[] {
  return arr(obj(e.message)?.content).map(obj).filter((b): b is Json => b !== undefined)
}

const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? ''

/** A notification's or progress report's status as one of ours ("completed" → done). */
function endStatus(status: unknown): AgentStatus | undefined {
  if (typeof status !== 'string') return undefined
  if (status === 'completed') return 'done'
  if (status === 'running' || status === 'pending') return undefined
  return 'failed' // failed, killed, stopped, error, …
}

/** The text of a tool_result's content (a string, or its text blocks). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content).map(obj).filter((b) => b?.type === 'text').map((b) => str(b?.text) ?? '').join('\n')
}

/**
 * Every sub-agent of the job, in the order they were started. `jobRunning`: whether the
 * job still runs (a sub-agent that hasn't ended when the job has is "stopped").
 */
export function agentsOf(events: readonly CodeEvent[], jobRunning: boolean): AgentInfo[] {
  const byId = new Map<string, AgentInfo>()
  // A background agent's own id (task_id / agentId) → its call id, for task_updated.
  const byTask = new Map<string, string>()
  const sorted = [...events].sort((a, b) => a.seq - b.seq)

  // 1. The calls, wherever they were made (the main agent or a sub-agent).
  for (const ev of sorted) {
    const e = obj(ev.event)
    if (!e || e.type !== 'assistant') continue
    for (const b of blocks(e)) {
      if (b.type !== 'tool_use' || !TASK_TOOLS.includes(str(b.name) ?? '')) continue
      const id = str(b.id)
      if (!id || byId.has(id)) continue
      const input = obj(b.input) ?? {}
      const prompt = str(input.prompt) ?? ''
      byId.set(id, {
        id,
        parent: parentOf(ev) ?? MAIN,
        depth: 1,
        description: firstLine(str(input.description) ?? prompt) || id,
        prompt,
        type: str(input.subagent_type),
        status: 'running',
        background: input.run_in_background === true,
        toolCalls: 0,
        startedAt: timeOf(ev, e),
        seq: ev.seq,
      })
    }
  }
  if (byId.size === 0) return []

  // 2. What each one did and how it ended.
  for (const ev of sorted) {
    const e = obj(ev.event)
    if (!e) continue
    const parent = byId.get(parentOf(ev) ?? '')
    if (parent && e.type === 'assistant') {
      parent.toolCalls += blocks(e).filter((b) => b.type === 'tool_use').length
    }
    if (e.type === 'user') {
      const details = obj(e.tool_use_result)
      for (const b of blocks(e)) {
        const agent = b.type === 'tool_result' ? byId.get(str(b.tool_use_id) ?? '') : undefined
        if (!agent) continue
        const agentId = str(details?.agentId)
        if (agentId) byTask.set(agentId, agent.id)
        if (details?.status === 'async_launched' || details?.isAsync === true) {
          agent.background = true // its end comes as a task_notification
          continue
        }
        agent.status = b.is_error === true ? 'failed' : 'done'
        agent.endedAt = timeOf(ev, e)
        agent.durationMs = num(details?.totalDurationMs) ?? agent.durationMs
        agent.resultText = resultText(b.content) || undefined
        const reported = num(details?.totalToolUseCount)
        if (reported !== undefined) agent.toolCalls = Math.max(agent.toolCalls, reported)
      }
    }
    if (e.type === 'system') {
      const taskId = str(e.task_id)
      const agent = byId.get(str(e.tool_use_id) ?? '') ?? byId.get(byTask.get(taskId ?? '') ?? '')
      if (!agent) continue
      if (taskId && e.subtype === 'task_started') byTask.set(taskId, agent.id)
      const usage = obj(e.usage)
      // Progress counts every call it made, also those whose events weren't stored.
      const calls = num(usage?.tool_uses)
      if (calls !== undefined) agent.toolCalls = Math.max(agent.toolCalls, calls)
      agent.durationMs = num(usage?.duration_ms) ?? agent.durationMs
      const status = e.subtype === 'task_notification' ? endStatus(e.status)
        : e.subtype === 'task_updated' ? endStatus(obj(e.patch)?.status) : undefined
      if (status && agent.status === 'running') {
        agent.status = status
        agent.endedAt = timeOf(ev, e)
      }
    }
  }

  // 3. Depth (a parent that isn't a known agent is the main one), and what never ended.
  const list = [...byId.values()]
  for (const agent of list) {
    let depth = 1
    let up = byId.get(agent.parent)
    const seen = new Set([agent.id])
    while (up && !seen.has(up.id)) {
      seen.add(up.id)
      depth += 1
      up = byId.get(up.parent)
    }
    if (agent.parent !== MAIN && !byId.has(agent.parent)) agent.parent = MAIN
    agent.depth = depth
    if (!jobRunning && agent.status === 'running') agent.status = 'stopped'
  }
  return list
}

/**
 * The sub-agents in the order the sidebar lists them: each one followed by the ones it
 * started (depth first), each level in the order they were started.
 */
export function agentTree(agents: readonly AgentInfo[]): AgentInfo[] {
  const children = new Map<string, AgentInfo[]>()
  for (const a of agents) {
    const list = children.get(a.parent)
    if (list) list.push(a)
    else children.set(a.parent, [a])
  }
  const out: AgentInfo[] = []
  const visit = (parent: string) => {
    for (const a of (children.get(parent) ?? []).sort((x, y) => x.seq - y.seq)) {
      out.push(a)
      visit(a.id)
    }
  }
  visit(MAIN)
  return out
}

/**
 * The events of one agent: `agent` = MAIN gives the main agent's (those without a parent,
 * and those whose parent isn't a sub-agent of this job, so nothing is lost when a call's
 * own event wasn't stored), otherwise the events of the sub-agent with that call id.
 */
export function eventsOfAgent(events: readonly CodeEvent[], agents: readonly AgentInfo[], agent: string): CodeEvent[] {
  if (agent !== MAIN) return events.filter((ev) => parentOf(ev) === agent)
  const known = new Set(agents.map((a) => a.id))
  return events.filter((ev) => {
    const parent = parentOf(ev)
    return parent === undefined || !known.has(parent)
  })
}

/** How long it ran (or runs, until `now`), in ms: as reported, else from its times. */
export function agentDurationMs(agent: AgentInfo, now: number = Date.now()): number | undefined {
  if (agent.status !== 'running' && agent.durationMs !== undefined) return agent.durationMs
  const start = agent.startedAt ? Date.parse(agent.startedAt) : NaN
  const end = agent.status === 'running' ? now : agent.endedAt ? Date.parse(agent.endedAt) : NaN
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    // A running agent: the larger of what it reported and the time since its start.
    return Math.max(end - start, agent.status === 'running' ? (agent.durationMs ?? 0) : 0)
  }
  return agent.durationMs
}

/** The address's query parameter that holds the agent shown (absent: the main agent). */
export const AGENT_PARAM = 'agent'

/** A query string ("?…" or "") without the agent shown: for links to other jobs and to the list. */
export function withoutAgent(params: URLSearchParams | string): string {
  const next = new URLSearchParams(params)
  next.delete(AGENT_PARAM)
  const text = next.toString()
  return text ? `?${text}` : ''
}
