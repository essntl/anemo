/**
 * Chat for the mock Anemo: conversations, turns, a run's SSE stream with Last-Event-ID,
 * cancel, and one approval. A message containing "approval" makes the run wait for an
 * approval of a `write_file` call; "slow" streams slowly. The answer is "You said: …",
 * like Anemo's fake provider.
 */
import type { ServerResponse } from 'node:http'
import { params, send, type MockAnemo } from './mockAnemo'

interface RunEvent { id: string; type: string; data: Record<string, unknown> }
interface Run {
  id: string
  conversationId: string
  messageId: string
  events: RunEvent[]
  listeners: Set<() => void>
  status: string
  approval: { id: string; status: string } | null
  resume: (() => void) | null
}

let seq = 0
const nextId = (p: string) => `${p}-${++seq}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TERMINAL = ['completed', 'failed', 'cancelled']

export function addChat(anemo: MockAnemo) {
  const conversations = new Map<string, Record<string, unknown>>()
  const messages = new Map<string, Record<string, unknown>[]>()
  const runs = new Map<string, Run>()
  const now = () => new Date().toISOString()

  const emit = (run: Run, type: string, data: Record<string, unknown>) => {
    run.events.push({ id: `${run.events.length + 1}-0`, type, data })
    if (type === 'run.status') run.status = String(data.status)
    for (const l of run.listeners) l()
  }
  const message = (run: Run) => messages.get(run.conversationId)!.find((m) => m.id === run.messageId)!

  async function play(run: Run, text: string) {
    emit(run, 'run.status', { status: 'running' })
    emit(run, 'run.model', { label: 'Echo' })
    if (text.includes('approval')) {
      run.approval = { id: nextId('approval'), status: 'pending' }
      emit(run, 'tool.started', {})
      emit(run, 'approval.requested', { approval_id: run.approval.id })
      emit(run, 'run.status', { status: 'waiting_approval' })
      await new Promise<void>((r) => (run.resume = r))
      if (TERMINAL.includes(run.status)) return
      emit(run, 'approval.resolved', { status: run.approval.status })
      emit(run, 'run.status', { status: 'running' })
    }
    const words = `You said: ${text}`.split(' ')
    for (const [i, w] of words.entries()) {
      if (TERMINAL.includes(run.status)) return
      await sleep(text.includes('slow') ? 250 : 15)
      if (TERMINAL.includes(run.status)) return
      const delta = w + (i < words.length - 1 ? ' ' : '')
      message(run).text = String(message(run).text) + delta
      emit(run, 'message.delta', { text: delta })
    }
    message(run).status = 'completed'
    conversations.get(run.conversationId)!.active_run_id = null
    emit(run, 'run.status', { status: 'completed' })
  }

  anemo.routes.set('GET /api/models', (_r, _b, res) =>
    send(res, 200, [{ id: 'm-echo', display_name: 'Echo', enabled: true, provider_enabled: true, capabilities: { chat: true } }]),
  )
  anemo.routes.set('GET /api/profiles', (_r, _b, res) => send(res, 200, []))
  anemo.routes.set('GET /api/conversations', (_r, _b, res) => send(res, 200, [...conversations.values()].reverse()))
  anemo.routes.set('POST /api/conversations', (_r, _b, res) => {
    const id = nextId('conv')
    const conv = { id, title: 'New chat', pinned: false, archived: false, model_id: null, last_message_at: now(), created_at: now(), active_run_id: null, default_mode: 'chat', profile_id: null, tags: [], temporary: false }
    conversations.set(id, conv)
    messages.set(id, [])
    send(res, 201, conv)
  })
  anemo.routes.set('GET /api/conversations/:id', (req, _b, res) => {
    const conv = conversations.get(params(req).id)
    return conv ? send(res, 200, conv) : send(res, 404, { error: { code: 'not_found', message: 'Conversation not found' } })
  })
  anemo.routes.set('GET /api/conversations/:id/messages', (req, _b, res) => send(res, 200, messages.get(params(req).id) ?? []))
  anemo.routes.set('POST /api/conversations/:id/turns', (req, body, res) => {
    const id = params(req).id
    const conv = conversations.get(id)!
    const { text, mode } = body as { text: string; mode: string }
    const list = messages.get(id)!
    const base = { reasoning: null, error: null, model_label: 'Echo', created_at: now(), attachments: [], references: [], questions: [], versions: [], version: 0 }
    const user = { ...base, id: nextId('msg'), seq: list.length, role: 'user', text, status: 'completed', run_id: null }
    const runId = nextId('run')
    const assistant = { ...base, id: nextId('msg'), seq: list.length + 1, role: 'assistant', text: '', status: 'streaming', run_id: runId, mode }
    list.push(user, assistant)
    conv.title = text.slice(0, 40)
    conv.active_run_id = runId
    conv.default_mode = mode
    const run: Run = { id: runId, conversationId: id, messageId: assistant.id, events: [], listeners: new Set(), status: 'queued', approval: null, resume: null }
    runs.set(runId, run)
    play(run, text).catch((e) => console.error("mock play failed", e))
    send(res, 202, { run_id: runId, user_message: user, assistant_message: assistant })
  })
  anemo.routes.set('GET /api/runs/:id/events', (req, _b, res: ServerResponse) => {
    const run = runs.get(params(req).id)
    if (!run) return send(res, 404, { error: { code: 'not_found', message: 'Run not found' } })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const after = req.headers['last-event-id']
    let sent = after ? run.events.findIndex((e) => e.id === after) + 1 : 0
    const flush = () => {
      for (; sent < run.events.length; sent++) {
        const e = run.events[sent]
        res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
      }
      if (TERMINAL.includes(run.status)) {
        run.listeners.delete(flush)
        res.end()
      }
    }
    run.listeners.add(flush)
    // The response's close is the client going away (the request's fires once it is read).
    res.on('close', () => run.listeners.delete(flush))
    flush()
  })
  anemo.routes.set('POST /api/runs/:id/cancel', (req, _b, res) => {
    const run = runs.get(params(req).id)!
    message(run).status = 'cancelled'
    conversations.get(run.conversationId)!.active_run_id = null
    emit(run, 'run.status', { status: 'cancelled' })
    run.resume?.()
    send(res, 200, { id: run.id, status: 'cancelled' })
  })
  anemo.routes.set('GET /api/runs/:id/timeline', (req, _b, res) => {
    const run = runs.get(params(req).id)!
    const calls = run.approval
      ? [{
          id: 'call-1', step: 1, position: 0, tool_name: 'write_file', capability: 'fs.write',
          args: { path: 'notes/todo.md', content: 'hello' }, actions: [{ summary: 'Write notes/todo.md' }],
          risk: 'moderate', decision: 'ask', decision_reason: null, is_error: false, result: null, result_data: null,
          status: run.approval.status === 'pending' ? 'waiting_approval' : 'completed', started_at: now(), ended_at: null,
          approval: { id: run.approval.id, run_id: run.id, tool_call_id: 'call-1', kind: 'action', status: run.approval.status, scope: null, summary: 'Write notes/todo.md', reason: null, created_at: now(), decided_at: null },
        }]
      : []
    send(res, 200, { run_id: run.id, kind: 'agent', status: run.status, pause_requested: false, plan: null, plan_version: 0, tool_calls: calls, file_changes: [] })
  })
  anemo.routes.set('POST /api/approvals/:id', (req, body, res) => {
    const run = [...runs.values()].find((r) => r.approval?.id === params(req).id)!
    const { decision } = body as { decision: string }
    run.approval!.status = decision === 'approve' ? 'approved' : 'denied'
    run.resume?.()
    send(res, 200, { ...run.approval, decided_at: now() })
  })
  return { conversations, messages, runs }
}
