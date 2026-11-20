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
import * as RadixDialog from '@radix-ui/react-dialog'
import { Link, useLocation, useNavigate } from 'react-router'
import { AlertTriangle, ArrowLeft, Check, Code2, Download, Folder, FolderInput, FolderPlus, History, Link2, ListPlus, Loader2, MessageSquare, PanelLeft, PanelRight, Pencil, Trash2, Type } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Button } from '@/components/ui/Button'
import { type Choice, chooseDialog, confirmDialog, promptDialog } from '@/components/ui/dialogs'
import { toast } from '@/components/ui/toast'
import { downloadUrl } from '@/features/files/api'
import { CodeEditor } from '@/features/files/components/CodeEditor'
import { useShareDialog } from '@/features/shares/shareStore'
import { useProjects } from '@/features/tasks/api'
import { useIslandVisible } from '@/features/island/islandStore'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { msg, plural, t } from '@/lib/i18n'
import { type DocumentContent, folderDefaults, oldPathMentions, updateMentions, useDeleteDocument, useDocument, useDocuments, useMoveDocument, useSetProperties } from '../api'
import { imagesToEditor, imagesToFile, joinFrontMatter, needsSourceMode, splitFrontMatter, tidyMarkdown } from '../markdown'
import { useShowPassage } from '../passage'
import { useOutline } from '../useOutline'
import { type SaveState, useAutosave } from '../useAutosave'
import { useAgentEdit } from '../agentEdit'
import { AgentEditNotice } from './AgentEditNotice'
import { DocumentChat } from './DocumentChat'
import { DocumentInfo } from './DocumentInfo'
import { RevisionsDialog } from './RevisionsDialog'
import { RichEditor } from './RichEditor'
import { Lingering } from '@/components/ui/Lingering'
import { DocumentBacklinks } from '@/features/links/DocumentBacklinks'
import { useProperties, valueLabel } from '@/features/properties/api'
import { HubList } from './HubList'
import { NewTaskDialog } from '@/features/links/NewTaskDialog'
import { documentLink } from '@/lib/appLinks'
import { PropertiesBar, showsProperties } from './PropertiesBar'

const STATUS: Record<SaveState, string> = {
  saved: msg('Saved'),
  unsaved: msg('Unsaved changes'),
  saving: msg('Saving…'),
  conflict: msg('Changed elsewhere'),
  error: msg('Not saved'),
}

function SaveStatus({ state }: { state: SaveState }) {
  const Icon = state === 'saved' ? Check : state === 'saving' ? Loader2 : state === 'unsaved' ? Pencil : AlertTriangle
  return (
    <span className={cn('flex shrink-0 items-center gap-1 text-[12px]', state === 'conflict' || state === 'error' ? 'text-warning' : 'text-muted')}>
      <Icon className={cn('h-3.5 w-3.5', state === 'saving' && 'animate-spin')} /> {t(STATUS[state])}
    </span>
  )
}

/** The list of documents beside the editor: whether it is put away, and the button's action. */
export interface ListToggle {
  hidden: boolean
  toggle: () => void
}

interface SessionProps {
  doc: DocumentContent // the version this session started from
  server: DocumentContent // the latest version known from the server
  onServerChanged: () => void
  onLoadOther: () => void
  list?: ListToggle
}

/** Browser storage: "0" while the panel beside a document (outline, details, chat) is hidden. */
const INFO_PANEL = "anemo.docInfo"
const WIDE = "(min-width: 1024px)"

function EditorSession({ doc, server, onServerChanged, onLoadOther, list }: SessionProps) {
  const navigate = useNavigate()
  const autosave = useAutosave(doc)
  const move = useMoveDocument()
  const remove = useDeleteDocument()
  const setProperties = useSetProperties(doc.id)
  const definitions = useProperties()
  const documents = useDocuments()
  const projects = useProjects()
  const [historyOpen, setHistoryOpen] = useState(false)
  // The panel beside the text (outline, details, chat). Wide screens: shown unless it was
  // hidden, remembered on this device. Narrower ones: it slides in over the text when asked for.
  const wide = useMediaQuery(WIDE)
  const desktop = useMediaQuery(DESKTOP)
  const [info, setInfo] = useState(() => { try { return localStorage.getItem(INFO_PANEL) !== "0" } catch { return true } })
  const [sheet, setSheet] = useState(false)
  const showInfo = wide ? info : sheet
  const toggleInfo = () => {
    if (!wide) return setSheet(!sheet)
    try { localStorage.setItem(INFO_PANEL, info ? "0" : "1") } catch { /* no storage: just not remembered */ }
    setInfo(!info)
  }
  // An agent's edit to decide about: shown in the panel, and as a dot on its button while it is put away.
  const agentEdit = useAgentEdit(doc.id)
  const openHistory = () => {
    setSheet(false)
    setHistoryOpen(true)
  }
  // Phones while the Dynamic Island shows: it takes the middle of the header, so the title moves to a row underneath.
  const stacked = useIslandVisible((s) => s.visible) && !desktop
  const askShare = useShareDialog((s) => s.ask)
  const start = useMemo(() => splitFrontMatter(doc.content), [doc.content])
  // Documents the rich editor would damage (raw HTML, footnotes) open as Markdown source.
  const richIsLossy = useMemo(() => needsSourceMode(start.body), [start.body])
  const [mode, setMode] = useState<'rich' | 'source'>(richIsLossy ? 'source' : 'rich')
  const frontMatter = useRef(start.frontMatter)
  const busy = autosave.state !== 'saved'
  // A link to a part of the document (#heading, #text=…): scroll there and highlight it.
  const page = useRef<HTMLDivElement>(null)
  const { hash, search } = useLocation()
  // Opened from the Inbox after the agent moved the document: the same offer as after a move here.
  const movedFrom = new URLSearchParams(search).get('moved_from')
  useEffect(() => {
    if (!movedFrom) return
    navigate(`/documents/${doc.id}${hash}`, { replace: true })
    void offerMentions(movedFrom)
    // Once, for the address it was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movedFrom])
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

  // After a move: offer the new folder's default properties, and to update project
  // instructions and memories that still name the old path. Nothing changes unasked.
  const afterMove = async (oldPath: string) => {
    const offered = await folderDefaults(doc.id).catch(() => ({}) as Record<string, unknown>)
    const keys = Object.keys(offered)
    if (keys.length > 0) {
      const byKey = new Map((definitions.data ?? []).map((d) => [d.key, d]))
      const list = keys.map((k) => `${byKey.get(k)?.label ?? k}: ${valueLabel(byKey.get(k), offered[k])}`).join(', ')
      const ok = await confirmDialog({ title: t('Use this folder’s properties?'), message: t('Documents in this folder usually have {list}.', { list }), confirmLabel: t('Apply') })
      if (ok && (await autosave.flush())) {
        setProperties.mutate({ set: offered, baseHash: autosave.baseHash() }, { onError: (err) => toast({ message: errorMessage(err) }) })
      }
    }
    await offerMentions(oldPath)
  }
  // Project instructions and memories that still name the old path: offered, never rewritten unasked.
  const offerMentions = async (oldPath: string) => {
    const mentions = await oldPathMentions(doc.id, oldPath).catch(() => [])
    if (mentions.length === 0) return
    const names = mentions.map((m) => (m.kind === 'project' ? t('the instructions of {project}', { project: m.title }) : t('the memory “{memory}”', { memory: m.title }))).join('; ')
    const update = await confirmDialog({
      title: t('Update the old path elsewhere?'),
      message: t('{places} still name {path}.', { places: names, path: oldPath }),
      confirmLabel: t('Update'),
    })
    if (update) {
      const done = await updateMentions(doc.id, oldPath, mentions.map((m) => ({ kind: m.kind, id: m.id })))
      toast({ message: plural(done.updated, 'Updated {n} place.', 'Updated {n} places.') })
    }
  }
  const rename = async () => {
    const current = server.path.slice(server.path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
    const name = await promptDialog({ title: t('Rename file'), label: t('File name'), initial: current, confirmLabel: t('Rename') })
    const oldPath = server.path
    if (name && name !== current) move.mutate({ id: doc.id, name }, { onSuccess: () => void afterMove(oldPath) })
  }
  // Pick where it goes: the top of Documents, a project, or one of the folders in
  // Documents (or a new one). Its history comes along.
  const moveToFolder = async () => {
    const NEW = ' new'
    const active = (projects.data ?? []).filter((p) => !p.archived)
    const projectOf = (folder: string) => active.find((p) => folder === p.slug || folder.startsWith(`${p.slug}/`))
    const here = (folder: string) => (folder === server.folder ? { disabled: true, hint: t('Here now') } : {})
    const dot = (color: string) => <span className="block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
    const folders = (documents.data?.folders ?? []).filter((f) => !active.some((p) => p.slug === f))
    const options: Choice[] = [
      { value: '', label: t('Documents'), hint: t('The top level'), icon: <Folder />, ...here('') },
      ...active.map((p) => ({ value: p.slug, label: p.name, hint: t('Project'), icon: dot(p.color), ...here(p.slug) })),
      ...folders.map((f) => {
        const project = projectOf(f)
        return {
          value: f,
          label: project ? `${project.name} / ${f.slice(project.slug.length + 1)}` : f,
          hint: project ? t('Folder in a project') : t('Folder'),
          icon: project ? dot(project.color) : <Folder />,
          ...here(f),
        }
      }),
      { value: NEW, label: t('New folder…'), icon: <FolderPlus /> },
    ]
    let folder = await chooseDialog({ title: t('Move “{title}”', { title: server.title }), message: t('Its history moves with it.'), options })
    if (folder === NEW) {
      folder = await promptDialog({ title: t('New folder'), label: t('Folder name inside Documents'), placeholder: t('e.g. travel/2026'), confirmLabel: t('Move') })
    }
    if (folder === null || folder.trim() === server.folder) return
    const target = folder.trim()
    const oldPath = server.path
    move.mutate({ id: doc.id, folder: target }, {
      onSuccess: () => {
        toast({ message: t('Moved to {place}.', { place: projectOf(target)?.name ?? (target || t('Documents')) }) })
        void afterMove(oldPath)
      },
    })
  }
  const confirmDelete = async () => {
    const ok = await confirmDialog({
      title: t('Delete “{title}”?', { title: server.title }),
      message: t('The file moves to the trash. You can restore it from Files → Trash (its revision history is not kept).'),
      confirmLabel: t('Delete'),
      danger: true,
    })
    if (ok) remove.mutate(doc.id, { onSuccess: () => navigate('/documents') })
  }
  const askAi = () => navigate(`/?doc=${encodeURIComponent(server.path)}&title=${encodeURIComponent(server.title)}`)
  const actionError = move.error ?? remove.error
  // A document in a project's folder: its chat is made in that project.
  const project = (projects.data ?? []).find((p) => !p.archived && (server.folder === p.slug || server.folder.startsWith(`${p.slug}/`)))
  // "New task": a task with the document's properties and a link back.
  const [newTask, setNewTask] = useState(false)

  const heading = (
    <>
      <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold" title={server.path}>{server.title}</h2>
      <SaveStatus state={autosave.state} />
    </>
  )
  const panel = (
    <DocumentInfo documentId={doc.id} path={server.path} words={outline.words} outline={outline.outline} active={outline.active}
      onJump={(index) => { outline.jump(index); setSheet(false) }} onHistory={openHistory} onClose={wide ? undefined : () => setSheet(false)}
      notice={agentEdit && <AgentEditNotice edit={agentEdit} onReview={openHistory} />}
      chat={<DocumentChat documentId={doc.id} title={server.title} path={server.path} projectId={project?.id ?? null} save={autosave.flush} />} />
  )

  return (
    <div ref={page} className="flex h-full min-w-0 flex-col">
      <header className="shrink-0 border-b border-border">
      <div className="flex h-12 items-center gap-2 px-2 md:px-4">
        <Link to="/documents" aria-label={t('All documents')} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-text md:hidden">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        {list && (
          <Button size="icon" variant="ghost" className="hidden shrink-0 md:inline-flex" aria-pressed={!list.hidden}
            aria-label={list.hidden ? t('Show the document list') : t('Hide the document list')} title={list.hidden ? t('Show the document list') : t('Hide the document list')}
            onClick={list.toggle}>
            <PanelLeft className="h-4 w-4" />
          </Button>
        )}
        {stacked ? <span className="flex-1" /> : heading}
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
        <Button size="icon" variant={showInfo && wide ? 'secondary' : 'ghost'} className="relative shrink-0" aria-label={t('Outline, details and chat')} aria-pressed={showInfo}
          title={showInfo ? t('Hide the outline, details and chat') : t('Show the outline, details and chat')} onClick={toggleInfo}>
          <PanelRight className="h-4 w-4" />
          {agentEdit && !showInfo && <span role="status" aria-label={t('An agent edited this document')} className="absolute right-[20%] top-[20%] h-2 w-2 rounded-full bg-accent ring-2 ring-surface" />}
        </Button>
        <ActionMenu actions={[
          { label: t('History'), icon: <History />, onSelect: () => setHistoryOpen(true) },
          { label: t('New task'), icon: <ListPlus />, onSelect: () => setNewTask(true) },
          { label: t('Ask the assistant'), icon: <MessageSquare />, onSelect: askAi },
          { label: mode === 'rich' ? t('Edit as Markdown') : t('Edit as rich text'), icon: mode === 'rich' ? <Code2 /> : <Type />,
            onSelect: () => (mode === 'rich' ? switchMode('source') : richIsLossy ? toast({ message: t('This document uses HTML or footnotes, which only the Markdown editor keeps.') }) : switchMode('rich')) },
          { label: t('Rename file'), icon: <Pencil />, onSelect: () => void rename() },
          { label: t('Move to project or folder'), icon: <FolderInput />, onSelect: () => void moveToFolder() },
          { label: t('Share'), icon: <Link2 />, onSelect: () => askShare({ kind: 'document', id: doc.id, title: server.title }) },
          { label: t('Download .md'), icon: <Download />, download: downloadUrl(server.path) },
          { label: t('Delete'), icon: <Trash2 />, danger: true, onSelect: () => void confirmDelete() },
        ]} />
      </div>
      {stacked && <div className="-mt-1 flex h-10 items-center gap-2 px-3">{heading}</div>}
      </header>

      <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
      {autosave.state === 'conflict' && (
        <div className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/8 px-4 py-2 text-[13px]">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <span className="min-w-48 flex-1">{t('This document was changed somewhere else (for example by an agent) while you were editing.')}</span>
          <Button size="sm" variant="secondary" onClick={onLoadOther}>{t('Load the other version')}</Button>
          <Button size="sm" variant="ghost" onClick={autosave.overwrite}>{t('Keep mine')}</Button>
        </div>
      )}
      {(autosave.state === 'error' || actionError) && (
        <div className="flex items-center gap-2 border-b border-border bg-error/10 px-4 py-2 text-[13px] text-error">
          <span className="flex-1">{actionError ? errorMessage(actionError) : autosave.error}</span>
          {autosave.state === 'error' && <Button size="sm" variant="secondary" onClick={autosave.saveNow}>{t('Try again')}</Button>}
        </div>
      )}

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
      {showInfo && wide && <aside aria-label={t('About this document')} className="flex w-72 shrink-0 flex-col border-l border-border 2xl:w-80">{panel}</aside>}
      </div>
      {!wide && (
        <RadixDialog.Root open={sheet} onOpenChange={setSheet}>
          <RadixDialog.Portal>
            <RadixDialog.Overlay className="fade fixed inset-0 z-40 bg-black/40" />
            <RadixDialog.Content aria-describedby={undefined}
              className="drawer-right fixed inset-y-0 right-0 z-50 flex w-[min(92vw,24rem)] flex-col bg-surface pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-float focus:outline-none">
              <RadixDialog.Title className="sr-only">{t('About this document')}</RadixDialog.Title>
              {panel}
            </RadixDialog.Content>
          </RadixDialog.Portal>
        </RadixDialog.Root>
      )}

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
  return (
    <EditorSession key={version} doc={session} server={data} onServerChanged={() => restart(data)} onLoadOther={loadOther} list={list} />
  )
}
