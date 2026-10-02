/**
 * One open document: the editor (rich text or Markdown source), autosave with its
 * status, and the document's actions.
 *
 * <DocumentEditor> loads the document; <EditorSession> holds the editing state
 * for one loaded version. When the file changes elsewhere while nothing is
 * unsaved here (an agent edited it, a revision was restored), the session is
 * simply restarted with the new text.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { AlertTriangle, ArrowLeft, Check, Code2, Download, FolderInput, History, Loader2, MessageSquare, Pencil, Trash2, Type } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Button } from '@/components/ui/Button'
import { confirmDialog, promptDialog } from '@/components/ui/dialogs'
import { toast } from '@/components/ui/toast'
import { downloadUrl } from '@/features/files/api'
import { CodeEditor } from '@/features/files/components/CodeEditor'
import { cn } from '@/lib/cn'
import { type DocumentContent, useDeleteDocument, useDocument, useMoveDocument } from '../api'
import { imagesToEditor, imagesToFile, joinFrontMatter, needsSourceMode, splitFrontMatter, tidyMarkdown } from '../markdown'
import { type SaveState, useAutosave } from '../useAutosave'
import { RevisionsDialog } from './RevisionsDialog'
import { RichEditor } from './RichEditor'
import { Lingering } from '@/components/ui/Lingering'

const STATUS: Record<SaveState, string> = {
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  conflict: 'Changed elsewhere',
  error: 'Not saved',
}

function SaveStatus({ state }: { state: SaveState }) {
  const Icon = state === 'saved' ? Check : state === 'saving' ? Loader2 : state === 'unsaved' ? Pencil : AlertTriangle
  return (
    <span className={cn('flex shrink-0 items-center gap-1 text-[12px]', state === 'conflict' || state === 'error' ? 'text-warning' : 'text-muted')}>
      <Icon className={cn('h-3.5 w-3.5', state === 'saving' && 'animate-spin')} /> {STATUS[state]}
    </span>
  )
}

interface SessionProps {
  doc: DocumentContent // the version this session started from
  server: DocumentContent // the latest version known from the server
  onServerChanged: () => void
  onLoadOther: () => void
}

function EditorSession({ doc, server, onServerChanged, onLoadOther }: SessionProps) {
  const navigate = useNavigate()
  const autosave = useAutosave(doc)
  const move = useMoveDocument()
  const remove = useDeleteDocument()
  const [historyOpen, setHistoryOpen] = useState(false)
  const start = useMemo(() => splitFrontMatter(doc.content), [doc.content])
  // Documents the rich editor would damage (raw HTML, footnotes) open as Markdown source.
  const richIsLossy = useMemo(() => needsSourceMode(start.body), [start.body])
  const [mode, setMode] = useState<'rich' | 'source'>(richIsLossy ? 'source' : 'rich')
  const frontMatter = useRef(start.frontMatter)
  const busy = autosave.state !== 'saved'

  // The file changed on the server and we have nothing unsaved: show the new version.
  const { state: saveState, baseHash } = autosave
  useEffect(() => {
    if (saveState === 'saved' && server.hash !== baseHash()) onServerChanged()
    // Only when the server version or our save state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.hash, saveState])

  const switchMode = (next: 'rich' | 'source') => {
    frontMatter.current = splitFrontMatter(autosave.text).frontMatter
    setMode(next)
  }
  const onRichChange = (markdown: string) =>
    autosave.setText(joinFrontMatter(frontMatter.current, imagesToFile(tidyMarkdown(markdown), server.path)))

  const rename = async () => {
    const current = server.path.slice(server.path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
    const name = await promptDialog({ title: 'Rename file', label: 'File name', initial: current, confirmLabel: 'Rename' })
    if (name && name !== current) move.mutate({ id: doc.id, name })
  }
  const moveToFolder = async () => {
    const folder = await promptDialog({
      title: 'Move to folder',
      label: 'Folder inside Documents (empty: top level)',
      initial: server.folder,
      placeholder: 'e.g. travel/2026',
      confirmLabel: 'Move',
    })
    if (folder !== null && folder.trim() !== server.folder) move.mutate({ id: doc.id, folder: folder.trim() })
  }
  const confirmDelete = async () => {
    const ok = await confirmDialog({
      title: `Delete “${server.title}”?`,
      message: 'The file moves to the trash. You can restore it from Files → Trash (its revision history is not kept).',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) remove.mutate(doc.id, { onSuccess: () => navigate('/documents') })
  }
  const askAi = () => navigate(`/?doc=${encodeURIComponent(server.path)}&title=${encodeURIComponent(server.title)}`)
  const actionError = move.error ?? remove.error

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2 md:px-4">
        <Link to="/documents" aria-label="All documents" className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-text md:hidden">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold" title={server.path}>{server.title}</h1>
        <SaveStatus state={autosave.state} />
        <div className="hidden rounded-lg bg-surface-2 p-0.5 sm:inline-flex" role="radiogroup" aria-label="Editor">
          {(['rich', 'source'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => switchMode(m)}
              disabled={m === 'rich' && richIsLossy}
              title={m === 'rich' && richIsLossy ? 'This document uses HTML or footnotes, which only the Markdown editor keeps' : undefined}
              className={cn('flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium disabled:opacity-40',
                mode === m ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}>
              {m === 'rich' ? <Type className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
              {m === 'rich' ? 'Rich text' : 'Markdown'}
            </button>
          ))}
        </div>
        <ActionMenu actions={[
          { label: 'History', icon: <History />, onSelect: () => setHistoryOpen(true) },
          { label: 'Ask the assistant', icon: <MessageSquare />, onSelect: askAi },
          { label: mode === 'rich' ? 'Edit as Markdown' : 'Edit as rich text', icon: mode === 'rich' ? <Code2 /> : <Type />,
            onSelect: () => (mode === 'rich' ? switchMode('source') : richIsLossy ? toast({ message: 'This document uses HTML or footnotes, which only the Markdown editor keeps.' }) : switchMode('rich')) },
          { label: 'Rename file', icon: <Pencil />, onSelect: () => void rename() },
          { label: 'Move to folder', icon: <FolderInput />, onSelect: () => void moveToFolder() },
          { label: 'Download .md', icon: <Download />, download: downloadUrl(server.path) },
          { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => void confirmDelete() },
        ]} />
      </header>

      {autosave.state === 'conflict' && (
        <div className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/8 px-4 py-2 text-[13px]">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <span className="min-w-48 flex-1">This document was changed somewhere else (for example by an agent) while you were editing.</span>
          <Button size="sm" variant="secondary" onClick={onLoadOther}>Load the other version</Button>
          <Button size="sm" variant="ghost" onClick={autosave.overwrite}>Keep mine</Button>
        </div>
      )}
      {(autosave.state === 'error' || actionError) && (
        <div className="flex items-center gap-2 border-b border-border bg-error/10 px-4 py-2 text-[13px] text-error">
          <span className="flex-1">{actionError ? errorMessage(actionError) : autosave.error}</span>
          {autosave.state === 'error' && <Button size="sm" variant="secondary" onClick={autosave.saveNow}>Try again</Button>}
        </div>
      )}

      {mode === 'rich' ? (
        <RichEditor initial={imagesToEditor(splitFrontMatter(autosave.text).body, server.path)} onChange={onRichChange}
          onError={(message) => toast({ message })} />
      ) : (
        <div className="min-h-0 flex-1">
          <CodeEditor path={server.path} value={autosave.text} onChange={autosave.setText} />
        </div>
      )}

      <Lingering value={historyOpen}>
        {() => <RevisionsDialog documentId={doc.id} unsaved={busy} onClose={() => setHistoryOpen(false)} />}
      </Lingering>
    </div>
  )
}

export function DocumentEditor({ id }: { id: string }) {
  const doc = useDocument(id)
  // The version being edited, and a counter that restarts the editing session.
  const [session, setSession] = useState<DocumentContent | null>(null)
  const [version, setVersion] = useState(0)
  const data = doc.data
  if (data && session === null) setSession(data) // first load

  const restart = (fresh: DocumentContent) => {
    setSession(fresh)
    setVersion((v) => v + 1)
  }
  /** Fetch the newest version from the server and edit that (drops local changes). */
  const loadOther = () => void doc.refetch().then((result) => result.data && restart(result.data))

  if (doc.isError) {
    return (
      <div className="p-8 text-[13px]">
        <p className="text-error">{errorMessage(doc.error)}</p>
        <Link to="/documents" className="mt-2 inline-block text-accent underline">All documents</Link>
      </div>
    )
  }
  if (!data || !session) return null
  return (
    <EditorSession key={version} doc={session} server={data} onServerChanged={() => restart(data)} onLoadOther={loadOther} />
  )
}
