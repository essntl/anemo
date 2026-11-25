/**
 * The places plugins show up in Anemo (contract §3), all fed by one cached request
 * (`GET /api/plugins/contributions`, only enabled and approved plugins):
 *
 *  - `PluginPanels`: the `object.panel` frames on a task or an event;
 *  - `PluginDocumentPanel` (with `usePluginDocumentTabs` in slotData.ts): one tab per panel
 *    beside a document;
 *  - `PluginLinks`: the plugins' pages, in their own group of the sidebar;
 *  - `PluginFences`: registers each `chat.block` fence with lib/fenceRenderers, so chat
 *    answers draw it (mounted once in AppLayout);
 *  - `PluginPage` (its own file): a plugin's page at /plugins/:pluginId/:uiId.
 *
 * With the kill switch on, every one of them shows nothing.
 */
import { useEffect } from 'react'
import { NavLink } from 'react-router'
import { cn } from '@/lib/cn'
import { type FenceRendererProps, registerFenceRenderer } from '@/lib/fenceRenderers'
import { t } from '@/lib/i18n'
import { usePluginContributions } from './api'
import { PluginFrame } from './host/PluginFrame'
import { NamedIcon, PluginIcon } from './PluginIcon'
import { activeFences, documentTabId, framePlugin, pagesOf, panelsFor, pluginPageLink, usePluginUis } from './slotData'
import type { ContributionUi, ObjectType } from './types'

/** A plugin's small heading above its panel: its icon and the panel's title. */
function PanelHeading({ ui }: { ui: ContributionUi }) {
  return (
    <div className="mb-1.5 flex items-center gap-2 text-[13px] font-medium">
      <PluginIcon url={ui.icon_url} size={18} className="rounded-md" />
      <span className="min-w-0 truncate">{ui.title ?? ui.plugin_name}</span>
    </div>
  )
}

/**
 * The plugin panels of a task or an event (in the task's details column, below the event's
 * fields). `revision` changes when the object was saved, so the panel can read it again.
 */
export function PluginPanels({ type, id, revision, className }: { type: ObjectType; id: string; revision?: string | null; className?: string }) {
  const all = usePluginUis()
  const panels = panelsFor(all, type)
  if (panels.length === 0) return null
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {panels.map((ui) => (
        <section key={`${ui.plugin_id}/${ui.id}`} aria-label={ui.title ?? ui.plugin_name}>
          <PanelHeading ui={ui} />
          <PluginFrame key={`${ui.plugin_id}@${ui.version}/${ui.id}`} plugin={framePlugin(ui)} ui={ui.id} slot="object.panel"
            permissions={ui.permissions} pages={pagesOf(all, ui.plugin_id)} context={{ object: { type, id } }}
            active height={ui.height} revision={revision} title={ui.title ?? ui.plugin_name} />
        </section>
      ))}
    </div>
  )
}

/** The content of a plugin's tab beside a document. */
export function PluginDocumentPanel({ tabId, documentId, revision }: { tabId: string; documentId: string; revision?: string | null }) {
  const all = usePluginUis()
  const ui = panelsFor(all, 'document').find((u) => documentTabId(u) === tabId)
  if (!ui) return null
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <PanelHeading ui={ui} />
      <PluginFrame key={`${ui.plugin_id}@${ui.version}/${ui.id}`} plugin={framePlugin(ui)} ui={ui.id} slot="object.panel"
        permissions={ui.permissions} pages={pagesOf(all, ui.plugin_id)} context={{ object: { type: 'document', id: documentId } }}
        active height={ui.height} revision={revision} title={ui.title ?? ui.plugin_name} />
    </div>
  )
}

/** The plugins' pages in the sidebar, under their own heading. */
export function PluginLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pages = usePluginUis().filter((u) => u.slot === 'page')
  if (pages.length === 0) return null
  return (
    <nav aria-label={t('Plugins')} className="mt-1 flex shrink-0 flex-col gap-0.5">
      <div className="px-2.5 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{t('Plugins')}</div>
      {pages.map((ui) => (
        <NavLink key={`${ui.plugin_id}/${ui.id}`} to={pluginPageLink(ui.plugin_id, ui.id)} onClick={onNavigate}
          className={({ isActive }) =>
            cn('flex h-(--nav-row-h) min-w-0 items-center gap-2.5 rounded-control px-2.5 text-[13px] font-medium transition-colors pointer-coarse:h-10',
              isActive ? 'bg-surface-2 font-semibold text-text [&>svg]:text-accent' : 'text-text hover:bg-surface-hover [&>svg]:text-muted')}>
          <NamedIcon name={ui.icon} className="h-[17px] w-[17px] shrink-0" fallback={<PluginIcon url={ui.icon_url} size={17} className="rounded-[5px]" />} />
          <span className="min-w-0 flex-1 truncate">{ui.title ?? ui.plugin_name}</span>
        </NavLink>
      ))}
    </nav>
  )
}

/** A fenced block in a chat answer, drawn by the plugin that claims its language. */
function PluginFenceBlock({ lang, text, fallback }: FenceRendererProps) {
  const all = usePluginUis()
  const ui = all.find((u) => u.slot === 'chat.block' && u.fence === lang)
  if (!ui) return <>{fallback}</>
  return (
    <div className="my-3">
      <PluginFrame key={`${ui.plugin_id}@${ui.version}/${ui.id}`} plugin={framePlugin(ui)} ui={ui.id} slot="chat.block"
        permissions={ui.permissions} pages={pagesOf(all, ui.plugin_id)} context={{ block: { lang, text } }}
        active height={ui.height} fallback={fallback} title={ui.title ?? ui.plugin_name} />
    </div>
  )
}

/**
 * Keeps lib/fenceRenderers in step with the enabled plugins' fences. Mounted once (in
 * AppLayout); draws nothing.
 */
export function PluginFences() {
  const data = usePluginContributions().data
  const fences = activeFences(data).join(',')
  useEffect(() => {
    if (!fences) return
    const stops = fences.split(',').map((fence) => registerFenceRenderer(fence, PluginFenceBlock))
    return () => stops.forEach((stop) => stop())
  }, [fences])
  return null
}
