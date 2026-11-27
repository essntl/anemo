/**
 * An open sketch: the drawing canvas in the documents' frame (header, save status,
 * actions, properties, panel), with autosave, the image the server keeps of it, asking
 * the assistant about it and its transcription.
 *
 * DocumentEditor loads the document and restarts this session (a new `key`) when the
 * drawing changed elsewhere while nothing was unsaved here; a change to only the words
 * around it (properties, the transcription) is taken without starting again.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Download, FolderInput, History, Link2, ListPlus, MessageSquare, Pencil, ScanText, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Button } from '@/components/ui/Button'
import { Lingering } from '@/components/ui/Lingering'
import { toast } from '@/components/ui/toast'
import { type DocumentContent, documentKey } from '@/features/documents/api'
import { DocumentHeader, PanelButton, SaveBanners, SaveStatus, type SessionProps, SidePanel } from '@/features/documents/components/DocumentShell'
import { useSidePanel } from '@/features/documents/useSidePanel'
import { DocumentInfo } from '@/features/documents/components/DocumentInfo'
import { PropertiesBar, showsProperties } from '@/features/documents/components/PropertiesBar'
import { RevisionsDialog } from '@/features/documents/components/RevisionsDialog'
import { useDocumentActions } from '@/features/documents/useDocumentActions'
import { downloadUrl } from '@/features/files/api'
import type { NewChatState } from '@/features/chat/useAttachments'
import { DocumentBacklinks } from '@/features/links/DocumentBacklinks'
import { NewTaskDialog } from '@/features/links/NewTaskDialog'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { documentLink } from '@/lib/appLinks'
import { msg, t } from '@/lib/i18n'
import { requestTranscription, useTranscriptionPoll } from './api'
import { SketchCanvas } from './canvas/SketchCanvas'
import { ensurePreview, sketchForChat } from './ensurePreview'
import { sketchFromFile } from './file'
import { Transcription } from './Transcription'
import { useSketchAutosave } from './useSketchAutosave'

const TRANSCRIPTION_TAB = msg('Text in the drawing')

/** The title, edited in place; saved with the drawing. */
function TitleField({ server, initial, onChange }: { server: DocumentContent; initial: string | null; onChange: (title: string) => void }) {
  const [value, setValue] = useState(initial ?? server.title)
  const [editing, setEditing] = useState(false)
  // Renamed elsewhere (or saved from here): show it, unless it is being typed.
  useEffect(() => {
    if (!editing) setValue((now) => (now.trim() === server.title ? now : server.title))
    // Only when the saved title changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.title])
  return (
    <input value={value} aria-label={t('Title')} title={server.path} maxLength={200}
      onFocus={() => setEditing(true)}
      onBlur={() => { setEditing(false); if (!value.trim()) setValue(server.title) }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur() }}
      onChange={(e) => { setValue(e.target.value); if (e.target.value.trim()) onChange(e.target.value) }}
      className="h-8 min-w-0 flex-1 truncate rounded-md bg-transparent px-1 text-[15px] font-semibold hover:bg-surface-hover focus:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent-soft" />
  )
}

/** A version in the history: its drawing, not to be changed. */
function RevisionSketch({ content }: { content: string }) {
  const data = sketchFromFile(content)
  if (!data) return <p className="text-[13px] text-muted">{t('This version has no drawing that can be read.')}</p>
  return (
    <div className="h-[50vh] overflow-hidden rounded-control border border-border bg-surface">
      <SketchCanvas data={data} onChange={() => undefined} readOnly className="h-full w-full" />
    </div>
  )
}

export function SketchSession({ doc, server, onServerChanged, onLoadOther, list }: SessionProps) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const autosave = useSketchAutosave(doc)
  const actions = useDocumentActions({ id: doc.id, server, save: autosave.flush, baseHash: autosave.baseHash })
  const panel = useSidePanel()
  const desktop = useMediaQuery(DESKTOP)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [newTask, setNewTask] = useState(false)
  const [asking, setAsking] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  // Brings the transcription's tab to the front after "Transcribe".
  const [showTranscription, setShowTranscription] = useState(0)
  const sketch = server.sketch
  const unreadable = !doc.sketch?.data
  useTranscriptionPoll(doc.id, sketch?.transcription_status === 'queued')

  // The file changed on the server and nothing is unsaved here: a new drawing starts the
  // session again; anything else (properties, transcription, title) is simply taken.
  const { state: saveState, baseHash, drawingHash, adopt } = autosave
  useEffect(() => {
    if (saveState !== 'saved' || server.hash === baseHash()) return
    if (sketch?.drawing_hash && sketch.drawing_hash === drawingHash()) adopt(server.hash)
    else onServerChanged()
    // Only when the server version or our save state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.hash, saveState])

  const openHistory = () => {
    panel.closeSheet()
    setHistoryOpen(true)
  }
  /** Saves what is drawn first: false (and says so) when it can't be. */
  const saved = async () => {
    if (await autosave.flush()) return true
    toast({ message: t('The drawing has changes that could not be saved yet. Sort that out first.') })
    return false
  }
  // A new chat with the sketch's image attached (Agent mode can read the sketch itself too).
  const askAbout = async () => {
    if (asking || !(await saved())) return
    setAsking(true)
    try {
      const attachment = await sketchForChat(doc.id, qc)
      const state: NewChatState = { attachments: [attachment] }
      navigate(`/?doc=${encodeURIComponent(server.path)}&title=${encodeURIComponent(server.title)}`, { state })
    } catch (err) {
      toast({ message: errorMessage(err) })
      setAsking(false)
    }
  }
  const transcribe = async () => {
    if (transcribing || !(await saved())) return
    setTranscribing(true)
    try {
      await ensurePreview(doc.id, qc)
      await requestTranscription(doc.id)
      await qc.invalidateQueries({ queryKey: documentKey(doc.id) }) // now queued
      panel.show()
      setShowTranscription((n) => n + 1)
    } catch (err) {
      toast({ message: errorMessage(err) })
    } finally {
      setTranscribing(false)
    }
  }
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${documentLink(doc.id)}`)
      toast({ message: t('The link is copied. To show the drawing in a document, use Embed a sketch in its toolbar.') })
    } catch {
      toast({ message: t("The browser didn't allow copying.") })
    }
  }
  const project = actions.project

  const heading = (
    <>
      <TitleField server={server} initial={autosave.initialTitle} onChange={autosave.setTitle} />
      <SaveStatus state={autosave.state} />
    </>
  )
  const info = (
    <DocumentInfo documentId={doc.id} path={server.path} onHistory={openHistory} onClose={panel.wide ? undefined : panel.closeSheet}
      showFirst={showTranscription}
      first={{ label: TRANSCRIPTION_TAB, content: <Transcription sketch={sketch} busy={transcribing} onTranscribe={() => void transcribe()} /> }} />
  )
  const properties = (edge?: 'bottom') => (
    <PropertiesBar doc={server} projectId={project?.id ?? null} baseHash={autosave.baseHash} flush={autosave.flush} edge={edge} />
  )

  return (
    <div className="swap-in flex h-full min-w-0 flex-col">
      <DocumentHeader list={list} heading={heading}>
        <Button size="sm" variant="ghost" className="shrink-0 max-sm:hidden" icon={<MessageSquare className="h-4 w-4" />}
          loading={asking} disabled={unreadable} onClick={() => void askAbout()}>
          {t('Ask about this sketch')}
        </Button>
        <PanelButton panel={panel} label={t('Text in the drawing and details')}
          showLabel={t('Show the text in the drawing and details')} hideLabel={t('Hide the text in the drawing and details')} />
        <ActionMenu actions={[
          { label: t('History'), icon: <History />, onSelect: openHistory },
          { label: t('Ask about this sketch'), icon: <MessageSquare />, onSelect: () => void askAbout() },
          { label: t('Transcribe'), icon: <ScanText />, onSelect: () => void transcribe() },
          { label: t('New task'), icon: <ListPlus />, onSelect: () => setNewTask(true) },
          { label: t('Copy link'), icon: <Link2 />, onSelect: () => void copyLink() },
          { label: t('Rename file'), icon: <Pencil />, onSelect: () => void actions.rename() },
          { label: t('Move to project or folder'), icon: <FolderInput />, onSelect: () => void actions.moveToFolder() },
          { label: t('Download .md'), icon: <Download />, download: downloadUrl(server.path) },
          { label: t('Delete'), icon: <Trash2 />, danger: true, onSelect: () => void actions.confirmDelete() },
        ]} />
      </DocumentHeader>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <SaveBanners state={autosave.state} error={autosave.error} actionError={actions.error}
            conflictText={t('This sketch was changed somewhere else while you were drawing.')}
            onLoadOther={() => { autosave.discard(); onLoadOther() }} onOverwrite={autosave.overwrite} onRetry={autosave.saveNow} />
          {(desktop || showsProperties(server)) && properties()}
          {unreadable ? (
            <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <AlertTriangle className="h-6 w-6 text-warning" />
              <div>
                <p className="text-[14px] font-semibold">{t('The drawing in this file can’t be read')}</p>
                <p className="mt-1 max-w-md text-[13px] text-muted">
                  {t('It was probably changed outside the app. An earlier version in the history can be restored.')}
                </p>
                {doc.sketch?.error && <p className="mt-2 max-w-md break-words font-mono text-[12px] text-subtle">{doc.sketch.error}</p>}
              </div>
              <Button size="sm" variant="secondary" icon={<History className="h-4 w-4" />} onClick={openHistory}>{t('Open the history')}</Button>
            </div>
          ) : (
            <div role="region" aria-label={t('Drawing sheet')} className="relative flex min-h-0 flex-1 flex-col">
              <SketchCanvas data={autosave.initial} onChange={autosave.change} className="min-h-0 flex-1" />
            </div>
          )}
          {!desktop && !showsProperties(server) && properties('bottom')}
          {!(panel.shown && panel.wide) && <DocumentBacklinks documentId={doc.id} />}
        </div>
        <SidePanel panel={panel} label={t('About this sketch')}>{info}</SidePanel>
      </div>

      <Lingering value={historyOpen}>
        {() => (
          <RevisionsDialog documentId={doc.id} unsaved={autosave.state !== 'saved'} onClose={() => setHistoryOpen(false)}
            preview={(content) => <RevisionSketch content={content} />} />
        )}
      </Lingering>
      <Lingering value={newTask}>
        {() => (
          <NewTaskDialog from={{ ref: documentLink(doc.id), title: server.title }} projectId={project?.id ?? null}
            properties={server.properties ?? {}} onClose={() => setNewTask(false)} />
        )}
      </Lingering>
    </div>
  )
}
