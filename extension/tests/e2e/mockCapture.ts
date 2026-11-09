/** Quick capture for the mock Anemo: documents, projects, saves (finished over the event stream), tasks. */
import { send, params, type MockAnemo } from './mockAnemo'
import type { MockEvents } from './mockEvents'

export function addCapture(anemo: MockAnemo, events: MockEvents) {
  const captures: Record<string, unknown>[] = []
  const tasks: Record<string, unknown>[] = []
  const undone: string[] = []
  anemo.routes.set('GET /api/documents', (_r, _b, res) =>
    send(res, 200, { folders: [], documents: [{ id: 'd1', path: 'documents/Biology.md', folder: '', title: 'Biology notes', word_count: 10, last_editor: 'user', updated_at: new Date().toISOString() }] }),
  )
  anemo.routes.set('GET /api/projects', (_r, _b, res) => send(res, 200, [{ id: 'p1', name: 'Thesis' }]))
  anemo.routes.set('POST /api/capture', (_r, body, res) => {
    const id = `cap-${captures.length + 1}`
    captures.push(body as Record<string, unknown>)
    send(res, 202, { id })
    const b = body as { target: { mode: string; document_id?: string | null } }
    const appendTo = b.target.mode === 'append' ? (b.target.document_id ?? 'inbox') : null
    setTimeout(() => events.publish('capture.progress', { id, status: 'formatting', done: 0, total: 2, result: null, error: null }), 50)
    setTimeout(
      () =>
        events.publish('capture.finished', {
          id, status: 'done', done: 2, total: 2, error: null,
          result: {
            document_id: appendTo ?? 'new-doc', path: 'documents/x.md', title: appendTo === 'inbox' ? 'Inbox' : appendTo ? 'Biology notes' : 'Photosynthesis explained', formatted: true,
            undo: appendTo ? { kind: 'restore', document_id: appendTo, revision_id: 'rev-1' } : { kind: 'delete', document_id: 'new-doc', revision_id: null },
          },
        }),
      400,
    )
  })
  anemo.routes.set('GET /api/capture/:id', (req, _b, res) => send(res, 200, { id: params(req).id, status: 'formatting', done: 0, total: 2, result: null, error: null }))
  anemo.routes.set('POST /api/documents/:id/revisions/:rid/restore', (req, _b, res) => {
    undone.push(`restore ${params(req).id} ${params(req).rid}`)
    send(res, 200, {})
  })
  anemo.routes.set('DELETE /api/documents/:id', (req, _b, res) => {
    undone.push(`delete ${params(req).id}`)
    res.writeHead(204).end()
  })
  anemo.routes.set('POST /api/tasks', (_r, body, res) => {
    tasks.push(body as Record<string, unknown>)
    send(res, 201, { id: 't-1', ...(body as object) })
  })
  return { captures, tasks, undone }
}
