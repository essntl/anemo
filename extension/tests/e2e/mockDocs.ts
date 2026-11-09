/** Documents for the mock Anemo (create, read, save with base_hash, images). */
import { createHash } from 'node:crypto'
import { params, send, type MockAnemo } from './mockAnemo'

export interface Doc { id: string; title: string; folder: string; path: string; content: string }

const hash = (s: string) => createHash('sha256').update(s).digest('hex')

export function addDocs(anemo: MockAnemo) {
  const docs = new Map<string, Doc>()
  const assets: string[] = []
  let n = 0
  const out = (d: Doc) => ({ id: d.id, path: d.path, folder: d.folder, title: d.title, word_count: d.content.split(/\s+/).length, last_editor: 'user', updated_at: new Date().toISOString(), content: d.content, hash: hash(d.content) })
  anemo.routes.set('GET /api/documents', (_r, _b, res) => send(res, 200, { folders: [], documents: [...docs.values()].map(out) }))
  anemo.routes.set('POST /api/documents', (_r, body, res) => {
    const b = body as { title: string; folder: string; content: string }
    const id = `doc-${++n}`
    const d = { id, title: b.title, folder: b.folder, path: `documents/${b.folder}/${b.title}.md`, content: b.content }
    docs.set(id, d)
    send(res, 201, out(d))
  })
  anemo.routes.set('GET /api/documents/:id', (req, _b, res) => {
    const d = docs.get(params(req).id)
    return d ? send(res, 200, out(d)) : send(res, 404, { error: { code: 'not_found', message: 'Document not found' } })
  })
  anemo.routes.set('PUT /api/documents/:id', (req, body, res) => {
    const d = docs.get(params(req).id)!
    const b = body as { content: string; base_hash: string }
    if (b.base_hash !== hash(d.content)) return send(res, 409, { error: { code: 'conflict_base_hash', message: 'Changed elsewhere' } })
    d.content = b.content
    send(res, 200, out(d))
  })
  anemo.routes.set('POST /api/documents/assets', (_r, _b, res) => {
    const path = `documents/_assets/frame-${assets.length + 1}.jpg`
    assets.push(path)
    send(res, 201, { path })
  })
  return { docs, assets }
}
