import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { History, X } from 'lucide-react'
import { allLinks, useLinks } from '@/features/links/api'
import { TYPE_ICONS } from '@/features/links/linkTypes'
import { PluginDocumentPanel } from '@/features/plugins/slots'
import { usePluginDocumentTabs } from '@/features/plugins/slotData'
import { ActorLine } from '@/features/provenance/Provenance'
import { HistoryLink } from '@/features/activity/HistoryLink'
import { actorLabel } from '@/features/provenance/labels'
import { cn } from '@/lib/cn'
import { formatWhen } from '@/lib/format'
import { dateLocale, msg, plural, t } from '@/lib/i18n'
import { useDocuments, useRevisions } from '../api'
import type { OutlineItem } from '../outline'

/** A built-in tab, or a plugin's panel: "plugin:<plugin id>/<ui id>" (features/plugins/slots.tsx). */
type Tab = 'outline' | 'details' | 'chat' | `plugin:${string}`
const TABS = [['outline', msg('Outline')], ['details', msg('Details')], ['chat', msg('Chat')]] as const

/** Browser storage: the tab of the panel beside a document that was open last. */
const TAB = 'anemo.docPanelTab'

const isPluginTab = (tab: string): tab is `plugin:${string}` => tab.startsWith('plugin:')

function lastTab(): Tab {
  try {
    const stored = localStorage.getItem(TAB) ?? ''
    // A plugin's tab is kept too: it shows once the plugins have loaded (or the outline, if it is gone).
    return TABS.some(([id]) => id === stored) || isPluginTab(stored) ? (stored as Tab) : 'outline'
  } catch {
    return 'outline'
  }
}

const LABEL = 'px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-subtle'
const ROW = 'flex min-h-8 w-full items-center gap-2 rounded-control px-2 text-left text-[13px] hover:bg-surface-hover'
const AUTHORS: Record<string, string> = { user: msg('You'), agent: msg('An agent'), extension: msg('The browser extension') }

/** How a heading of each level is set in the outline: size, weight, colour and how far in. */
const LEVEL: Record<number, string> = {
  1: 'mt-2 pl-2 text-[13px] font-semibold text-text first:mt-0',
  2: 'pl-5 text-[13px] text-text',
  3: 'pl-8 text-[12.5px] text-muted',
}

/** The document's headings as a tree: a click goes there, and the one being read is marked. */
function Outline({ outline, active, onJump }: { outline: OutlineItem[]; active: number; onJump: (index: number) => void }) {
  const list = useRef<HTMLElement>(null)
  // The marked heading stays in sight while the document scrolls.
  useEffect(() => {
    list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  if (outline.length === 0) {
    return <p className="p-4 text-[13px] text-muted">{t('Headings show up here. Use H1, H2 and H3 in the toolbar to give the document a structure.')}</p>
  }
  return (
    <nav ref={list} aria-label={t('Outline')} className="min-h-0 flex-1 overflow-y-auto p-2">
      {outline.map((h, i) => (
        <button key={`${h.line}-${h.slug}`} type="button" onClick={() => onJump(i)} title={h.title} aria-current={i === active ? 'true' : undefined}
          className={cn('relative flex min-h-8 w-full items-center rounded-control py-1 pr-2 text-left leading-snug hover:bg-surface-hover', LEVEL[h.level],
            // Under a top-level heading the rest hangs on a thin line, so the levels read at a glance.
            h.level > 1 && 'before:absolute before:inset-y-0 before:left-[9px] before:w-px before:bg-border',
            i === active && 'bg-accent-soft font-medium text-accent hover:bg-accent-soft before:w-0.5 before:bg-accent')}>
          <span className="line-clamp-2">{h.title}</span>
        </button>
      ))}
    </nav>
  )
}

/** What the document is, what links to it and its latest versions. */
function Details({ documentId, path, words, onHistory }: { documentId: string; path: string; words?: number; onHistory: () => void }) {
  const links = useLinks('document', documentId).data
  const back = allLinks(links?.backlinks)
  const revisions = useRevisions(documentId, true)
  // Who made it (who saved each version is in the history below).
  const created = useDocuments().data?.documents.find((d) => d.id === documentId)?.created_by_actor
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-3">
      <section aria-label={t('File')}>
        <div className={LABEL}>{t('File')}</div>
        <p className="break-all px-2 font-mono text-[12px] text-muted">{path}</p>
        {words !== undefined && (
          <p className="px-2 pt-1 text-[13px]">
            {plural(words, '{count} word', '{count} words', { count: words.toLocaleString(dateLocale()) })}
            <span className="text-muted"> · {t('about {minutes} min to read', { minutes: Math.max(1, Math.round(words / 220)) })}</span>
          </p>
        )}
        <ActorLine created={created} className="px-2 pt-1" />
        <HistoryLink type="document" id={documentId} className="block px-2 pt-1" />
      </section>

      <section aria-label={t('Linked from')}>
        <div className={LABEL}>{t('Linked from')}</div>
        {links && back.length === 0 && <p className="px-2 text-[13px] text-muted">{t('Nothing links here yet.')}</p>}
        {back.map((l) => (
          <Link key={`${l.type}:${l.id}`} to={l.ref} title={l.detail || undefined} className={cn(ROW, '[&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0 [&>svg]:text-muted')}>
            {TYPE_ICONS[l.type]}<span className="min-w-0 truncate">{l.title}</span>
          </Link>
        ))}
      </section>

      <section aria-label={t('History')}>
        <div className={LABEL}>{t('History')}</div>
        {(revisions.data ?? []).slice(0, 6).map((r) => (
          <button key={r.id} type="button" onClick={onHistory} className={cn(ROW, 'min-h-11 items-start py-1.5')}>
            <History className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="min-w-0">
              <span className="block truncate">{r.actor ? actorLabel(r.actor) : t(AUTHORS[r.author] ?? r.author)}{r.current && ` · ${t('current')}`}</span>
              <span className="block text-[12px] text-muted">{formatWhen(r.updated_at)}</span>
            </span>
          </button>
        ))}
        {revisions.data?.length === 0 && <p className="px-2 text-[13px] text-muted">{t('No versions yet.')}</p>}
        {(revisions.data?.length ?? 0) > 6 && (
          <button type="button" onClick={onHistory} className="px-2 pt-1 text-[12.5px] font-medium text-accent hover:underline">{t('All versions')}</button>
        )}
      </section>
    </div>
  )
}

/**
 * Beside a document, on three tabs: its outline; what the file is, what links to it and
 * its latest versions; and a chat with the assistant to have the document changed. Tabs,
 * so a long outline is never mixed up with the rest. Shown and hidden with the button in
 * the editor's header; on a narrow screen it slides in over the text (`onClose`).
 *
 * A sketch has no outline, word count or chat beside it: `first` takes the outline's
 * place (its transcription), and without `chat` there is no chat tab.
 */
export function DocumentInfo({ documentId, path, words, outline = [], active = -1, onJump, onHistory, notice, chat, first, showFirst, onClose }: {
  documentId: string
  path: string
  words?: number
  outline?: OutlineItem[]
  /** The outline item being read under, or -1. */
  active?: number
  onJump?: (index: number) => void
  onHistory: () => void
  /** Something to decide about the document (an agent edited it), above the tabs. */
  notice?: ReactNode
  /** The chat tab's content. */
  chat?: ReactNode
  /** The first tab instead of the outline. */
  first?: { label: string; content: ReactNode }
  /** A number that, when it changes, brings the first tab to the front (to show what an action put there). */
  showFirst?: number
  /** Set when the panel lies over the text: a button to put it away. */
  onClose?: () => void
}) {
  const [chosen, setTabState] = useState<Tab>(lastTab)
  const setTab = (next: Tab) => {
    try { localStorage.setItem(TAB, next) } catch { /* no storage: just not remembered */ }
    setTabState(next)
  }
  // Asked to show the first tab (a new number): during render, as React suggests for this.
  const [firstAsked, setFirstAsked] = useState(showFirst)
  if (showFirst !== firstAsked) {
    setFirstAsked(showFirst)
    setTabState('outline')
  }
  // Plugins' panels for documents, one tab each, after the built-in ones.
  const pluginTabs = usePluginDocumentTabs()
  const builtIn = TABS.filter(([id]) => id !== 'chat' || chat).map(([id, label]) => [id, id === 'outline' && first ? first.label : label, true] as const)
  const tabs: (readonly [Tab, string, boolean])[] = [...builtIn, ...pluginTabs.map((p) => [p.id as Tab, p.label, false] as const)]
  // A plugin's tab that isn't there (turned off, or still loading) shows the outline (as does the chat without one).
  const tab: Tab = (isPluginTab(chosen) && !pluginTabs.some((p) => p.id === chosen)) || (chosen === 'chat' && !chat) ? 'outline' : chosen
  return (
    <div className="flex h-full min-h-0 flex-col">
      {notice}
      <div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
        <div role="tablist" aria-label={t('About this document')} className="flex min-w-0 flex-1 rounded-lg bg-surface-2 p-0.5">
          {tabs.map(([id, label, translated]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} title={translated ? undefined : label}
              className={cn('flex h-7 min-w-0 flex-auto items-center justify-center gap-1.5 rounded-md px-1 text-[12.5px] font-medium transition-colors pointer-coarse:h-9 pointer-coarse:text-[13.5px]',
                tab === id ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}>
              {/* A plugin's own title is shown as it is (plugin texts aren't translated). */}
              <span className="truncate">{translated ? t(label) : label}</span>
              {id === 'outline' && !first && outline.length > 0 && <span className="text-[11px] font-normal tabular-nums text-subtle">{outline.length}</span>}
            </button>
          ))}
        </div>
        {onClose && (
          <button type="button" aria-label={t('Close')} onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {tab === 'outline' && (first ? first.content : <Outline outline={outline} active={active} onJump={onJump ?? (() => undefined)} />)}
      {tab === 'details' && <Details documentId={documentId} path={path} words={words} onHistory={onHistory} />}
      {tab === 'chat' && chat}
      {isPluginTab(tab) && <PluginDocumentPanel tabId={tab} documentId={documentId} />}
    </div>
  )
}
