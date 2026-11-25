/**
 * Autosave for one open sketch, as useAutosave is for a text document.
 *
 * Each change of the drawing (or the title) is saved a moment after the last one. Each
 * save says which file version it was drawn on: when the file changed elsewhere, the
 * server refuses and the state becomes 'conflict' (unless only the words around the
 * drawing changed, its properties or transcription: then it is saved on top of them).
 *
 * Without a connection the drawing is kept on this device (draft.ts) and tried again,
 * later and when the browser is back online. After each save the sketch's image is drawn
 * and uploaded, so embeds and chats show it as it is now.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, errorMessage } from '@/api/client'
import { type DocumentContent, documentKey, documentsKey } from '@/features/documents/api'
import type { SaveState } from '@/features/documents/useAutosave'
import { fetchDocument, isTransient, saveSketch } from './api'
import { clearDraft, draftOutcome, readDraft, writeDraft } from './draft'
import { uploadDrawing } from './ensurePreview'
import { toSketchData } from './file'
import { emptySketch, type SketchData } from './model'

export const SAVE_DELAY_MS = 1200
/** Waits before trying again without a connection; the last one repeats. */
export const RETRY_MS = [2000, 5000, 10_000, 30_000, 60_000]

const isConflict = (err: unknown) => err instanceof ApiError && err.code === 'conflict_base_hash'

interface Start {
  data: SketchData
  /** The title typed and not saved yet, or null. */
  title: string | null
  state: SaveState
}

/** The server's drawing, or the one kept on this device when that is newer. */
function startFrom(doc: DocumentContent): Start {
  const server = doc.sketch?.data ? toSketchData(doc.sketch.data) : null
  const draft = readDraft(doc.id)
  if (!server) return { data: emptySketch(), title: null, state: 'saved' }
  if (!draft) return { data: server, title: null, state: 'saved' }
  const outcome = draftOutcome(draft, doc)
  if (outcome === 'drop') {
    clearDraft(doc.id)
    return { data: server, title: null, state: 'saved' }
  }
  return { data: draft.data, title: draft.title, state: outcome === 'resume' ? 'unsaved' : 'conflict' }
}

export function useSketchAutosave(doc: DocumentContent) {
  const qc = useQueryClient()
  const id = doc.id
  const [start] = useState(() => startFrom(doc))
  const [state, setStateValue] = useState<SaveState>(start.state)
  const [error, setError] = useState<string | null>(null)
  // Refs hold what the timers and async saves need without re-creating them.
  const stateRef = useRef(start.state)
  const latest = useRef(start.data) // the drawing on screen
  const latestTitle = useRef(start.title)
  const saved = useRef<SketchData | null>(start.state === 'saved' ? start.data : null) // what the server has from us
  const savedTitle = useRef<string | null>(null)
  const hash = useRef(doc.hash) // the file version the next save is based on
  const drawingHash = useRef(doc.sketch?.drawing_hash ?? null) // the drawing version the server has
  const saving = useRef(false)
  const conflict = useRef(start.state === 'conflict')
  const retries = useRef(0)
  const timer = useRef<number | undefined>(undefined)
  const saveRef = useRef<(overwrite?: boolean) => Promise<void>>(async () => undefined)

  const setState = useCallback((next: SaveState) => {
    stateRef.current = next
    setStateValue(next)
  }, [])
  const pending = () => latest.current !== saved.current || latestTitle.current !== savedTitle.current
  const keepDraft = useCallback(() => {
    writeDraft(id, { data: latest.current, title: latestTitle.current, baseHash: hash.current, at: Date.now() })
  }, [id])
  const schedule = useCallback((delay = SAVE_DELAY_MS) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void saveRef.current(), delay)
  }, [])

  /** The image for the drawing the server now has, unless it already has one. */
  const uploadImage = useCallback((result: DocumentContent, data: SketchData) => {
    const sketch = result.sketch
    if (!sketch?.drawing_hash || sketch.preview_current) return
    // A newer save uploads its own; another failure leaves the old image, marked not current.
    uploadDrawing(id, data, sketch.drawing_hash, qc).catch(() => undefined)
  }, [id, qc])

  const save = useCallback(async (overwrite = false) => {
    window.clearTimeout(timer.current)
    if (saving.current || (!pending() && !overwrite)) return
    const data = latest.current
    const title = latestTitle.current
    saving.current = true
    setState('saving')
    try {
      let result: DocumentContent
      try {
        result = await saveSketch(id, data, overwrite ? null : hash.current, title ?? undefined)
      } catch (err) {
        if (overwrite || !isConflict(err)) throw err
        // Changed elsewhere: if the drawing there is still the one we started from, only
        // its properties or transcription changed, and saving keeps those.
        const fresh = await fetchDocument(id)
        if (!fresh.sketch?.drawing_hash || fresh.sketch.drawing_hash !== drawingHash.current) throw err
        hash.current = fresh.hash
        result = await saveSketch(id, data, fresh.hash, title ?? undefined)
      }
      hash.current = result.hash
      drawingHash.current = result.sketch?.drawing_hash ?? null
      saved.current = data
      savedTitle.current = title
      conflict.current = false
      retries.current = 0
      saving.current = false
      setError(null)
      qc.setQueryData(documentKey(id), result)
      void qc.invalidateQueries({ queryKey: documentsKey }) // the title may have changed
      if (pending()) {
        keepDraft() // on the new version
        setState('unsaved')
        schedule()
      } else {
        clearDraft(id)
        setState('saved')
      }
      uploadImage(result, data)
    } catch (err) {
      saving.current = false
      if (isConflict(err)) {
        conflict.current = true
        setState('conflict')
      } else if (isTransient(err)) {
        // Kept on this device (it is, since the change); tried again later.
        setError(errorMessage(err))
        setState('offline')
        schedule(RETRY_MS[Math.min(retries.current, RETRY_MS.length - 1)])
        retries.current += 1
      } else {
        setError(errorMessage(err))
        setState('error')
      }
    }
  }, [id, qc, keepDraft, schedule, setState, uploadImage])
  useEffect(() => {
    saveRef.current = save
  }, [save])

  const changed = useCallback(() => {
    keepDraft()
    window.clearTimeout(timer.current)
    if (conflict.current) return // nothing is saved until the user has decided
    setState('unsaved')
    retries.current = 0
    schedule()
  }, [keepDraft, schedule, setState])

  /** The canvas committed a change: the whole new drawing. */
  const change = useCallback((next: SketchData) => {
    latest.current = next
    changed()
  }, [changed])

  const setTitle = useCallback((next: string) => {
    latestTitle.current = next
    changed()
  }, [changed])

  // A draft restored from this device: save it soon. A drawing whose image is out of
  // date (a restored version, an outside edit): draw it once.
  useEffect(() => {
    if (start.state === 'unsaved') schedule()
    const sketch = doc.sketch
    if (start.state === 'saved' && sketch?.data && sketch.drawing_hash && !sketch.preview_current) {
      uploadDrawing(id, start.data, sketch.drawing_hash, qc).catch(() => undefined)
    }
    // Once, for the version this session started from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Back online: try at once.
  useEffect(() => {
    const online = () => {
      if (stateRef.current === 'offline') void saveRef.current()
    }
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [])

  // Leaving the sketch (or closing the tab): send what is still pending. The draft stays
  // until the server has it, so nothing is lost if this doesn't arrive.
  useEffect(() => {
    const flush = () => {
      window.clearTimeout(timer.current)
      if (!pending() || saving.current || conflict.current) return
      const data = latest.current
      const title = latestTitle.current
      void saveSketch(id, data, hash.current, title ?? undefined).then((result) => {
        qc.setQueryData(documentKey(id), result)
        if (latest.current === data && latestTitle.current === title) clearDraft(id)
        uploadImage(result, data)
      }, () => undefined)
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, qc, uploadImage])

  /**
   * Saves what is pending and waits for it. False when the server doesn't have the
   * drawing afterwards (a conflict to decide, no connection, or the save failed).
   */
  const flush = useCallback(async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (conflict.current) return false
      if (saving.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 50))
        continue
      }
      if (!pending()) return true
      const data = latest.current
      await saveRef.current()
      if (latest.current === data && saved.current !== data) return false
    }
    return false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    /** The drawing to start the canvas with (the server's, or a newer one kept here). */
    initial: start.data,
    /** A title typed before and not saved yet, or null. */
    initialTitle: start.title,
    state,
    error,
    change,
    setTitle,
    /** Hash of the file version the edits are based on. */
    baseHash: () => hash.current,
    /** The drawing version the server has from us. */
    drawingHash: () => drawingHash.current,
    /** The file changed elsewhere, but not its drawing: carry on from that version. */
    adopt: (fileHash: string) => {
      hash.current = fileHash
    },
    saveNow: () => void save(),
    flush,
    /** After a conflict: write this drawing over the other version. */
    overwrite: () => void save(true),
    /** After a conflict: drop this drawing (the other version is loaded instead). */
    discard: () => {
      window.clearTimeout(timer.current)
      clearDraft(id)
      latest.current = saved.current ?? latest.current
      latestTitle.current = savedTitle.current
      conflict.current = true // nothing more is saved from this session
    },
  }
}
