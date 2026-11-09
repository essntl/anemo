/** Research sessions for the mock Anemo: sessions and sources in memory, research.changed on each change. */
import { params, send, type MockAnemo } from './mockAnemo'
import type { MockEvents } from './mockEvents'

interface Source { id: string; position: number; kind: string; url: string; title: string; content: string; word_count: number; note: string; key: boolean; created_at: string }
interface Session { id: string; topic: string; status: string; conversation_id: string | null; writeup_document_id: string | null; created_at: string; updated_at: string; ended_at: string | null; writeup_status: string | null; writeup_error: string | null; sources: Source[] }

export function addResearch(anemo: MockAnemo, events: MockEvents, chat: { conversations: Map<string, Record<string, unknown>>; messages: Map<string, unknown[]> }) {
  const sessions: Session[] = []
  const ended: { id: string; format: string }[] = []
  let n = 0
  const now = () => new Date().toISOString()
  const out = (s: Session) => {
    const { sources, ...rest } = s
    return { ...rest, source_count: sources.length }
  }
  const detail = (s: Session) => ({ ...out(s), sources: s.sources.map(({ content: _c, ...x }) => x) })
  const changed = (s: Session, extra: Record<string, unknown> = {}) => events.publish('research.changed', { session_id: s.id, ...extra })
  const find = (id: string) => sessions.find((s) => s.id === id)
  const sourceById = (id: string) => sessions.flatMap((s) => s.sources.map((x) => ({ s, x }))).find((p) => p.x.id === id)

  anemo.routes.set('GET /api/research/sessions', (_r, _b, res) =>
    send(res, 200, [...sessions].sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.updated_at.localeCompare(a.updated_at)).map(out)),
  )
  anemo.routes.set('POST /api/research/sessions', (_r, body, res) => {
    if (sessions.some((s) => s.status === 'active')) return send(res, 409, { error: { code: 'session_active', message: 'Another research session is active. Pause or end it first.', details: null } })
    const s: Session = { id: `rs-${++n}`, topic: (body as { topic: string }).topic, status: 'active', conversation_id: null, writeup_document_id: null, created_at: now(), updated_at: now(), ended_at: null, writeup_status: null, writeup_error: null, sources: [] }
    sessions.push(s)
    send(res, 201, detail(s))
    changed(s)
  })
  anemo.routes.set('GET /api/research/sessions/:id', (req, _b, res) => {
    const s = find(params(req).id)
    if (!s) return send(res, 404, { error: { code: 'not_found', message: 'Research session not found', details: null } })
    send(res, 200, detail(s))
  })
  anemo.routes.set('PATCH /api/research/sessions/:id', (req, body, res) => {
    const s = find(params(req).id)!
    const b = body as { topic?: string | null; status?: string | null }
    if (b.status === 'active' && sessions.some((x) => x !== s && x.status === 'active')) return send(res, 409, { error: { code: 'session_active', message: 'Another research session is active. Pause or end it first.', details: null } })
    if (b.topic) s.topic = b.topic
    if (b.status) s.status = b.status
    s.updated_at = now()
    send(res, 200, detail(s))
    changed(s)
  })
  anemo.routes.set('POST /api/research/sessions/:id/sources', (req, body, res) => {
    const s = find(params(req).id)!
    const b = body as { kind: string; url: string; title: string; content: string; note: string }
    const x: Source = { id: `src-${++n}`, position: s.sources.length + 1, kind: b.kind, url: b.url, title: b.title, content: b.content, word_count: b.content.split(/\s+/).filter(Boolean).length, note: b.note, key: false, created_at: now() }
    s.sources.push(x)
    s.updated_at = now()
    const { content: _c, ...shown } = x
    send(res, 201, shown)
    changed(s)
  })
  anemo.routes.set('PATCH /api/research/sources/:id', (req, body, res) => {
    const { s, x } = sourceById(params(req).id)!
    const b = body as { note?: string | null; key?: boolean | null }
    if (b.note !== null && b.note !== undefined) x.note = b.note
    if (b.key !== null && b.key !== undefined) x.key = b.key
    const { content: _c, ...shown } = x
    send(res, 200, shown)
    changed(s)
  })
  anemo.routes.set('DELETE /api/research/sources/:id', (req, _b, res) => {
    const { s, x } = sourceById(params(req).id)!
    s.sources = s.sources.filter((y) => y !== x)
    res.writeHead(204).end()
    changed(s)
  })
  anemo.routes.set('PUT /api/research/sessions/:id/order', (req, body, res) => {
    const s = find(params(req).id)!
    const ids = (body as { source_ids: string[] }).source_ids
    s.sources = ids.map((id, i) => ({ ...s.sources.find((x) => x.id === id)!, position: i + 1 }))
    res.writeHead(204).end()
    changed(s)
  })
  anemo.routes.set('POST /api/research/sessions/:id/conversation', (req, _b, res) => {
    const s = find(params(req).id)!
    if (!s.conversation_id) {
      s.conversation_id = 'c-research'
      chat.conversations.set(s.conversation_id, { id: s.conversation_id, title: `Research: ${s.topic}`, pinned: false, archived: false, model_id: null, last_message_at: now(), created_at: now(), active_run_id: null, default_mode: 'chat', profile_id: null, tags: [], temporary: false })
      chat.messages.set(s.conversation_id, [])
    }
    send(res, 200, { conversation_id: s.conversation_id })
    changed(s)
  })
  anemo.routes.set('POST /api/research/sessions/:id/end', (req, body, res) => {
    const s = find(params(req).id)!
    ended.push({ id: s.id, format: (body as { format: string }).format })
    s.status = 'ended'
    s.ended_at = now()
    s.writeup_status = 'writing'
    send(res, 202, out(s))
    changed(s, { writeup: { status: 'writing' } })
    setTimeout(() => {
      s.writeup_status = 'done'
      s.writeup_document_id = 'doc-writeup'
      changed(s, { writeup: { status: 'done', document_id: 'doc-writeup' } })
    }, 500)
  })
  return { sessions, ended }
}
