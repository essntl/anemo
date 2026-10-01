/**
 * Autosave for one open document.
 *
 * Every change is saved about a second after typing stops. Each save tells the
 * server which version it started from; if the file was changed elsewhere in the
 * meantime (an agent, another tab), the server refuses and the state becomes
 * 'conflict' so the user can choose which version to keep.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, errorMessage } from '@/api/client'
import { documentKey, documentsKey, type DocumentContent, saveDocument } from './api'

export type SaveState = 'saved' | 'unsaved' | 'saving' | 'conflict' | 'error'

const DELAY_MS = 1200

export function useAutosave(doc: DocumentContent) {
  const qc = useQueryClient()
  const [text, setTextState] = useState(doc.content)
  const [state, setState] = useState<SaveState>('saved')
  const [error, setError] = useState<string | null>(null)
  // Refs hold what the timers and async saves need without re-creating them.
  const latest = useRef(doc.content) // what is in the editor
  const saved = useRef(doc.content) // what the server has from us
  const hash = useRef(doc.hash) // version the next save is based on
  const saving = useRef(false)
  const conflict = useRef(false) // set while the user has to choose a version
  const timer = useRef<number | undefined>(undefined)
  // The newest `save`, so a timer set earlier still calls the current one.
  const saveRef = useRef<(overwrite?: boolean) => Promise<void>>(async () => undefined)
  const schedule = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void saveRef.current(), DELAY_MS)
  }, [])

  const save = useCallback(
    async (overwrite = false) => {
      window.clearTimeout(timer.current)
      if (saving.current || (latest.current === saved.current && !overwrite)) return
      const content = latest.current
      saving.current = true
      setState('saving')
      try {
        const result = await saveDocument(doc.id, content, overwrite ? null : hash.current)
        hash.current = result.hash
        saved.current = content
        conflict.current = false
        qc.setQueryData(documentKey(doc.id), result)
        void qc.invalidateQueries({ queryKey: documentsKey }) // the title may have changed
        saving.current = false
        if (latest.current !== content) {
          setState('unsaved')
          schedule()
        } else {
          setState('saved')
        }
      } catch (err) {
        saving.current = false
        if (err instanceof ApiError && err.code === 'conflict_base_hash') {
          conflict.current = true
          setState('conflict')
        } else {
          setError(errorMessage(err))
          setState('error')
        }
      }
    },
    [doc.id, qc, schedule],
  )
  useEffect(() => {
    saveRef.current = save
  }, [save])

  const setText = useCallback(
    (next: string) => {
      latest.current = next
      setTextState(next)
      window.clearTimeout(timer.current)
      if (conflict.current) return // nothing is saved until the user has decided
      setState('unsaved')
      schedule()
    },
    [schedule],
  )

  // Leaving the document (or closing the tab): save what is still pending.
  useEffect(() => {
    const flush = () => {
      window.clearTimeout(timer.current)
      if (latest.current !== saved.current && !saving.current) {
        void saveDocument(doc.id, latest.current, hash.current).then(
          (result) => qc.setQueryData(documentKey(doc.id), result),
          () => undefined,
        )
      }
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [doc.id, qc])

  return {
    text,
    setText,
    state,
    error,
    /** Hash of the version our edits are based on. */
    baseHash: () => hash.current,
    saveNow: () => void save(),
    /** After a conflict: write our text over the other version. */
    overwrite: () => void save(true),
  }
}
