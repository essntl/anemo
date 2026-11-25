/**
 * The frame around an open document, shared by the text editor (DocumentEditor) and the
 * sketch view (features/sketch/SketchDocument): the header with its buttons, the save
 * status, the banners for a conflict or an error, and the panel beside the document.
 */
import type { ReactNode } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { Link } from 'react-router'
import { AlertTriangle, ArrowLeft, Check, CloudOff, Loader2, PanelLeft, PanelRight, Pencil } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { useIslandVisible } from '@/features/island/islandStore'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { msg, t } from '@/lib/i18n'
import type { DocumentContent } from '../api'
import type { SaveState } from '../useAutosave'
import type { SidePanelState } from '../useSidePanel'

const STATUS: Record<SaveState, string> = {
  saved: msg('Saved'),
  unsaved: msg('Unsaved changes'),
  saving: msg('Saving…'),
  conflict: msg('Changed elsewhere'),
  error: msg('Not saved'),
  offline: msg('Offline: kept on this device'),
}

export function SaveStatus({ state }: { state: SaveState }) {
  const Icon = state === 'saved' ? Check : state === 'saving' ? Loader2 : state === 'unsaved' ? Pencil : state === 'offline' ? CloudOff : AlertTriangle
  return (
    <span className={cn('flex shrink-0 items-center gap-1 text-[12px]', state === 'conflict' || state === 'error' || state === 'offline' ? 'text-warning' : 'text-muted')}>
      <Icon className={cn('h-3.5 w-3.5', state === 'saving' && 'animate-spin')} /> {t(STATUS[state])}
    </span>
  )
}

/** The list of documents beside the editor: whether it is put away, and the button's action. */
export interface ListToggle {
  hidden: boolean
  toggle: () => void
}

/** What DocumentEditor gives the session that edits one loaded version (text or sketch). */
export interface SessionProps {
  doc: DocumentContent // the version this session started from
  server: DocumentContent // the latest version known from the server
  onServerChanged: () => void
  onLoadOther: () => void
  list?: ListToggle
}

/** The button in the header that shows and hides the panel; `dot` marks something in it to look at. */
export function PanelButton({ panel, label, showLabel, hideLabel, dot }: {
  panel: SidePanelState; label: string; showLabel: string; hideLabel: string; dot?: ReactNode
}) {
  return (
    <Button size="icon" variant={panel.shown && panel.wide ? 'secondary' : 'ghost'} className="relative shrink-0" aria-label={label} aria-pressed={panel.shown}
      title={panel.shown ? hideLabel : showLabel} onClick={panel.toggle}>
      <PanelRight className="h-4 w-4" />
      {!panel.shown && dot}
    </Button>
  )
}

/**
 * The header: back to the list (phones), the list toggle, the title and save status
 * (`heading`), then `children` (the editor's own buttons, the panel button, the actions).
 * On phones while the Dynamic Island shows, it takes the middle of the header, so the
 * title moves to a row underneath.
 */
export function DocumentHeader({ list, heading, children }: { list?: ListToggle; heading: ReactNode; children: ReactNode }) {
  const desktop = useMediaQuery(DESKTOP)
  const stacked = useIslandVisible((s) => s.visible) && !desktop
  return (
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
        {children}
      </div>
      {stacked && <div className="-mt-1 flex h-10 items-center gap-2 px-3">{heading}</div>}
    </header>
  )
}

/** Under the header: the choice after a conflict, and what went wrong with a save or an action. */
export function SaveBanners({ state, error, actionError, conflictText, onLoadOther, onOverwrite, onRetry }: {
  state: SaveState
  error: string | null
  actionError: unknown
  conflictText: string
  onLoadOther: () => void
  onOverwrite: () => void
  onRetry: () => void
}) {
  return (
    <>
      {state === 'conflict' && (
        <div className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/8 px-4 py-2 text-[13px]">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <span className="min-w-48 flex-1">{conflictText}</span>
          <Button size="sm" variant="secondary" onClick={onLoadOther}>{t('Load the other version')}</Button>
          <Button size="sm" variant="ghost" onClick={onOverwrite}>{t('Keep mine')}</Button>
        </div>
      )}
      {(state === 'error' || Boolean(actionError)) && (
        <div className="flex items-center gap-2 border-b border-border bg-error/10 px-4 py-2 text-[13px] text-error">
          <span className="flex-1">{actionError ? errorMessage(actionError) : error}</span>
          {state === 'error' && <Button size="sm" variant="secondary" onClick={onRetry}>{t('Try again')}</Button>}
        </div>
      )}
    </>
  )
}

/** The panel's place: beside the document on a wide screen, a sheet over it otherwise. */
export function SidePanel({ panel, label, children }: { panel: SidePanelState; label: string; children: ReactNode }) {
  if (panel.wide) {
    return panel.shown ? <aside aria-label={label} className="flex w-72 shrink-0 flex-col border-l border-border 2xl:w-80">{children}</aside> : null
  }
  return (
    <RadixDialog.Root open={panel.sheet} onOpenChange={panel.setSheet}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fade fixed inset-0 z-40 bg-black/40" />
        <RadixDialog.Content aria-describedby={undefined}
          className="drawer-right fixed inset-y-0 right-0 z-50 flex w-[min(92vw,24rem)] flex-col bg-surface pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-float focus:outline-none">
          <RadixDialog.Title className="sr-only">{label}</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
