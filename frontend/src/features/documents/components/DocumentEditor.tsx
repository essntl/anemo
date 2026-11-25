/**
 * One open document: the editor (rich text or Markdown source), autosave with its
 * status, and the document's actions. A sketch opens in its own view instead
 * (features/sketch/SketchDocument), in the same frame (DocumentShell).
 *
 * <DocumentEditor> loads the document; <EditorSession> holds the editing state
 * for one loaded version. When the file changes elsewhere while nothing is
 * unsaved here (an agent edited it, a revision was restored), the session is
 * simply restarted with the new text.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Code2, Download, FolderInput, History, Link2, ListPlus, MessageSquare, Pencil, Trash2, Type } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { toast } from '@/components/ui/toast'
import { downloadUrl } from '@/features/files/api'
import { CodeEditor } from '@/features/files/components/CodeEditor'
import { useShareDialog } from '@/features/shares/shareStore'
import { SketchSession } from '@/features/sketch/SketchDocument'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { type DocumentContent, useDocument } from '../api'
import { imagesToEditor, imagesToFile, joinFrontMatter, needsSourceMode, splitFrontMatter, tidyMarkdown } from '../markdown'
import { useShowPassage } from '../passage'
import { useOutline } from '../useOutline'
import { useAutosave } from '../useAutosave'
import { useAgentEdit } from '../agentEdit'
import { useDocumentActions } from '../useDocumentActions'
import { AgentEditNotice } from './AgentEditNotice'
import { DocumentChat } from './DocumentChat'
import { DocumentInfo } from './DocumentInfo'
import { DocumentHeader, type ListToggle, PanelButton, SaveBanners, SaveStatus, type SessionProps, SidePanel } from './DocumentShell'
import { useSidePanel } from '../useSidePanel'
import { RevisionsDialog } from './RevisionsDialog'
import { RichEditor } from './RichEditor'
import { Lingering } from '@/components/ui/Lingering'
import { DocumentBacklinks } from '@/features/links/DocumentBacklinks'
import { HubList } from './HubList'
import { NewTaskDialog } from '@/features/links/NewTaskDialog'
import { documentLink } from '@/lib/appLinks'
import { PropertiesBar, showsProperties } from './PropertiesBar'

function EditorSession({ doc, server, onServerChanged, onLoadOther, list }: SessionProps) {
  const navigate = useNavigate()
  const autosave = useAutosave(doc)
  const actions = useDocumentActions({ id: doc.id, server, save: autosave.flush, baseHash: autosave.baseHash })
  const [historyOpen, setHistoryOpen] = useState(false)
  // The panel beside the text (outline, details, chat).
  const panel = useSidePanel()
  const desktop = useMediaQuery(DESKTOP)
  const { wide, shown: showInfo } = panel
  // An agent's edit to decide about: shown in the panel, and as a dot on its button while it is put away.
  const agentEdit = useAgentEdit(doc.id)
  const openHistory = () => {
    panel.closeSheet()
    setHistoryOpen(true)
  }
  const askShare = useShareDialog((s) => s.ask)
  const start = useMemo(() => splitFrontMatter(doc.content), [doc.content])
  // Documents the rich editor would damage (raw HTML, footnotes) open as Markdown source.
  const richIsLossy = useMemo(() => needsSourceMode(start.body), [start.body])
  const [mode, setMode] = useState<'rich' | 'source'>(richIsLossy ? 'source' : 'rich')
  const frontMatter = useRef(start.frontMatter)
  const busy = autosave.state !== 'saved'
  // A link to a part of the document (#heading, #text=…): scroll there and highlight it.
  const page = useRef<HTMLDivElement>(null)
  const { hash } = useLocation()
  useShowPassage(page, hash, () => toast({ message: t('The quoted passage isn’t in this document any more.') }))
  // The outline of what is being typed, the heading in view (rich editor) and the way to one.
  const outline = useOutline(page, autosave.text, showInfo && mode === 'rich')

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

  const askAi = () => navigate(`/?doc=${encodeURIComponent(server.path)}&title=${encodeURIComponent(server.title)}`)
  const project = actions.project
  // "New task": a task with the document's properties and a link back.
  const [newTask, setNewTask] = useState(false)

  const heading = (
    <>
      <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold" title={server.path}>{server.title}</h2>
      <SaveStatus state={autosave.state} />
    </>
  )
  const info = (
    <DocumentInfo documentId={doc.id} path={server.path} words={outline.words} outline={outline.outline} active={outline.active}
      onJump={(index) => { outline.jump(index); panel.closeSheet() }} onHistory={openHistory} onClose={wide ? undefined : panel.closeSheet}
      notice={agentEdit && <AgentEditNotice edit={agentEdit} onReview={openHistory} />}
      chat={<DocumentChat documentId={doc.id} title={server.title} path={server.path} projectId={project?.id ?? null} save={autosave.flush} />} />
  )

  return (
    <div ref={page} className="flex h-full min-w-0 flex-col">
      <DocumentHeader list={list} heading={heading}>
        <div className="hidden shrink-0 rounded-lg bg-surface-2 p-0.5 sm:inline-flex" role="radiogroup" aria-label={t('Editor')}>
          {(['rich', 'source'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => switchMode(m)}
              disabled={m === 'rich' && richIsLossy}
              title={m === 'rich' && richIsLossy ? t('This document uses HTML or footnotes, which only the Markdown editor keeps') : undefined}
              className={cn('flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium disabled:opacity-40',
                mode === m ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}>
              {m === 'rich' ? <Type className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
              {m === 'rich' ? t('Rich text') : 'Markdown'}
            </button>
          ))}
        </div>
        <PanelButton panel={panel} label={t('Outline, details and chat')}
          showLabel={t('Show the outline, details and chat')} hideLabel={t('Hide the outline, details and chat')}
          dot={agentEdit && <span role="status" aria-label={t('An agent edited this document')} className="absolute right-[20%] top-[20%] h-2 w-2 rounded-full bg-accent ring-2 ring-surface" />} />
        <ActionMenu actions={[
          { label: t('History'), icon: <History />, onSelect: () => setHistoryOpen(true) },
          { label: t('New task'), icon: <ListPlus />, onSelect: () => setNewTask(true) },
          { label: t('Ask the assistant'), icon: <MessageSquare />, onSelect: askAi },
          { label: mode === 'rich' ? t('Edit as Markdown') : t('Edit as rich text'), icon: mode === 'rich' ? <Code2 /> : <Type />,
            onSelect: () => (mode === 'rich' ? switchMode('source') : richIsLossy ? toast({ message: t('This document uses HTML or footnotes, which only the Markdown editor keeps.') }) : switchMode('rich')) },
          { label: t('Rename file'), icon: <Pencil />, onSelect: () => void actions.rename() },
          { label: t('Move to project or folder'), icon: <FolderInput />, onSelect: () => void actions.moveToFolder() },
          { label: t('Share'), icon: <Link2 />, onSelect: () => askShare({ kind: 'document', id: doc.id, title: server.title }) },
          { label: t('Download .md'), icon: <Download />, download: downloadUrl(server.path) },
          { label: t('Delete'), icon: <Trash2 />, danger: true, onSelect: () => void actions.confirmDelete() },
        ]} />
      </DocumentHeader>

      <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
      <SaveBanners state={autosave.state} error={autosave.error} actionError={actions.error}
        conflictText={t('This document was changed somewhere else (for example by an agent) while you were editing.')}
        onLoadOther={onLoadOther} onOverwrite={autosave.overwrite} onRetry={autosave.saveNow} />

      {/* A phone keeps the text high on the screen: a document without properties offers
          "+ Property" below its text instead of in a bar above it. */}
      {(desktop || showsProperties(server)) && (
        <PropertiesBar doc={server} projectId={project?.id ?? null} baseHash={autosave.baseHash} flush={autosave.flush} />
      )}
      {mode === 'rich' ? (
        <RichEditor initial={imagesToEditor(splitFrontMatter(autosave.text).body, server.path)} onChange={onRichChange}
          onError={(message) => toast({ message })} />
      ) : (
        <div className="min-h-0 flex-1">
          <CodeEditor path={server.path} value={autosave.text} onChange={autosave.setText} />
        </div>
      )}
      {!desktop && !showsProperties(server) && (
        <PropertiesBar doc={server} projectId={project?.id ?? null} baseHash={autosave.baseHash} flush={autosave.flush} edge="bottom" />
      )}
      <HubList documentId={doc.id} />
      {!(showInfo && wide) && <DocumentBacklinks documentId={doc.id} />}
      </div>
      <SidePanel panel={panel} label={t('About this document')}>{info}</SidePanel>
      </div>

      <Lingering value={historyOpen}>
        {() => <RevisionsDialog documentId={doc.id} unsaved={busy} onClose={() => setHistoryOpen(false)} />}
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

export function DocumentEditor({ id, list }: { id: string; list?: ListToggle }) {
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
        <Link to="/documents" className="mt-2 inline-block text-accent underline">{t('All documents')}</Link>
      </div>
    )
  }
  if (!data || !session) return null
  // A sketch (a drawing sheet) has its own view in the same frame.
  const Session = session.kind === 'sketch' ? SketchSession : EditorSession
  return (
    <Session key={version} doc={session} server={data} onServerChanged={() => restart(data)} onLoadOther={loadOther} list={list} />
  )
}
