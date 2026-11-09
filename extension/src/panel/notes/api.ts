/** Notes documents in Anemo: one per video, in documents/YouTube/. */
import { unwrap, ApiError, type Api } from '@/shared/api'
import { storage } from '@/shared/storage'
import { newNotesDocument, parseNotesDocument, renderNotesDocument, sortNotes, type Note } from '@/shared/youtube'

export const FOLDER = 'YouTube'

export interface Video {
  id: string
  title: string
  channel: string
}

/** The video's notes document, if there is one (remembered per video; else found by
 *  title in documents/YouTube and checked for the video's link). */
export async function findNotesDocument(api: Api, video: Video): Promise<string | null> {
  const known = (await storage.get('local', 'youtubeDocs')) ?? {}
  const remembered = known[video.id]
  if (remembered) {
    try {
      unwrap(await api.GET('/api/documents/{document_id}', { params: { path: { document_id: remembered } } }))
      return remembered
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err
    }
  }
  const list = unwrap(await api.GET('/api/documents')).documents.filter((d) => d.folder === FOLDER)
  for (const d of list.filter((x) => x.title === video.title)) {
    const doc = unwrap(await api.GET('/api/documents/{document_id}', { params: { path: { document_id: d.id } } }))
    if (doc.content.includes(`youtu.be/${video.id}`)) {
      await storage.set('local', 'youtubeDocs', { ...known, [video.id]: d.id })
      return d.id
    }
  }
  return null
}

export async function loadNotes(api: Api, documentId: string): Promise<Note[]> {
  const doc = unwrap(await api.GET('/api/documents/{document_id}', { params: { path: { document_id: documentId } } }))
  return parseNotesDocument(doc.content).notes
}

/**
 * Changes the notes and saves. Creates the document on the first note. If the document was
 * changed elsewhere in the meantime (Anemo says 409), it is read again and the change
 * applied once more.
 */
export async function changeNotes(api: Api, video: Video, documentId: string | null, change: (notes: Note[]) => Note[]): Promise<{ documentId: string; notes: Note[] }> {
  if (!documentId) {
    const parsed = parseNotesDocument(newNotesDocument(video))
    const notes = sortNotes(change(parsed.notes))
    const created = unwrap(
      await api.POST('/api/documents', { body: { title: video.title || 'YouTube video', folder: FOLDER, content: renderNotesDocument(video.id, { ...parsed, notes }) } }),
    )
    const known = (await storage.get('local', 'youtubeDocs')) ?? {}
    await storage.set('local', 'youtubeDocs', { ...known, [video.id]: created.id })
    return { documentId: created.id, notes }
  }
  for (let attempt = 0; ; attempt++) {
    const doc = unwrap(await api.GET('/api/documents/{document_id}', { params: { path: { document_id: documentId } } }))
    const parsed = parseNotesDocument(doc.content)
    const notes = sortNotes(change(parsed.notes))
    try {
      unwrap(
        await api.PUT('/api/documents/{document_id}', {
          params: { path: { document_id: documentId } },
          body: { content: renderNotesDocument(video.id, { ...parsed, notes }), base_hash: doc.hash },
        }),
      )
      return { documentId, notes }
    } catch (err) {
      if (attempt === 0 && err instanceof ApiError && err.status === 409) continue
      throw err
    }
  }
}

/** Uploads a captured frame into Anemo's document images; returns its workspace path. */
export async function uploadFrame(api: Api, dataUrl: string, videoId: string, seconds: number): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob()
  const form = new FormData()
  form.append('file', blob, `frame-${videoId}-${Math.floor(seconds)}.jpg`)
  return unwrap(await api.POST('/api/documents/assets', { body: form as never, bodySerializer: (b) => b as unknown as FormData })).path
}
