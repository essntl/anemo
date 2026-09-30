import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Download, FileQuestion, Save, X } from 'lucide-react'
import { ApiError, errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { contentKey, downloadUrl, type Entry, useFileContent, useSaveFile } from '../api'
import { CodeEditor } from './CodeEditor'

const IMAGE = /\.(png|jpe?g|gif|webp)$/i

/** Text editor with conflict-safe saving (the server rejects saves over newer changes). */
function TextEditor({ path, onClose }: { path: string; onClose: () => void }) {
  const qc = useQueryClient()
  const content = useFileContent(path)
  const save = useSaveFile()
  // `edited` is null until the user types; the loaded file is the source otherwise.
  const [edited, setEdited] = useState<string | null>(null)
  // Set when a save was rejected because the file changed elsewhere.
  const [conflictHash, setConflictHash] = useState<string | null>(null)

  const loaded = content.data
  const text = edited ?? loaded?.content ?? ''
  const dirty = edited !== null && loaded !== undefined && edited !== loaded.content

  const doSave = async (overwrite = false) => {
    if (!loaded || edited === null) return
    try {
      const saved = await save.mutateAsync({
        path,
        content: edited,
        base_hash: overwrite && conflictHash ? conflictHash : loaded.hash,
      })
      // The saved text is now the loaded version.
      qc.setQueryData(contentKey(path), { ...loaded, content: edited, hash: saved.hash })
      setEdited(null)
      setConflictHash(null)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict_base_hash') {
        setConflictHash((err.details as { current_hash?: string } | undefined)?.current_hash ?? '')
      }
    }
  }

  // Ctrl/Cmd+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        if (dirty) void doSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (content.isError) {
    return <NonText path={path} note={errorMessage(content.error)} />
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:px-4">
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{path}</span>
        {dirty && <span className="text-[12px] text-warning">Unsaved</span>}
        <Button size="sm" variant="primary" icon={<Save className="h-3.5 w-3.5" />} disabled={!dirty}
          loading={save.isPending} onClick={() => void doSave()}>
          Save
        </Button>
        <CloseButton onClose={onClose} />
      </div>
      {conflictHash !== null && (
        <div className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-[12.5px]">
          This file was changed elsewhere (maybe by an agent) since you opened it.
          <Button size="sm" variant="secondary"
            onClick={() => { setEdited(null); setConflictHash(null); void content.refetch() }}>
            Load their version
          </Button>
          <Button size="sm" variant="danger" onClick={() => void doSave(true)}>Overwrite with mine</Button>
        </div>
      )}
      {save.isError && conflictHash === null && (
        <div className="px-4 py-2 text-[12.5px] text-error">{errorMessage(save.error)}</div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {loaded ? <CodeEditor path={path} value={text} onChange={setEdited} /> : <p className="p-4 text-muted">Loading…</p>}
      </div>
    </div>
  )
}

/** Desktop closes the side pane (X); on phones the file is full-screen, so it's "back". */
function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button size="icon" variant="ghost" aria-label="Close" onClick={onClose} className="max-md:order-first max-md:-ml-2">
      <X className="hidden h-4 w-4 md:block" />
      <ArrowLeft className="h-5 w-5 md:hidden" />
    </Button>
  )
}

function NonText({ path, note }: { path: string; note?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <FileQuestion className="h-8 w-8 text-subtle" />
      <div className="text-[13px] text-muted">{note ?? 'No preview for this file type.'}</div>
      <a href={downloadUrl(path)} className="inline-flex h-8 items-center gap-1.5 rounded-control bg-surface-2 px-3 text-[13px] hover:bg-surface-hover">
        <Download className="h-3.5 w-3.5" /> Download
      </a>
    </div>
  )
}

export function FilePreview({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  if (IMAGE.test(entry.name)) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:px-4">
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{entry.path}</span>
          <a href={downloadUrl(entry.path)} download className="rounded-lg p-2 text-muted hover:bg-surface-hover" aria-label="Download">
            <Download className="h-4 w-4" />
          </a>
          <CloseButton onClose={onClose} />
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-2 p-4">
          <img src={downloadUrl(entry.path)} alt={entry.name} className="max-h-full max-w-full rounded-lg shadow-soft" />
        </div>
      </div>
    )
  }
  // key: switching files resets the editor state.
  return <TextEditor key={entry.path} path={entry.path} onClose={onClose} />
}
