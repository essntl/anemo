/**
 * What the slots need from the contributions (`GET /api/plugins/contributions`): which UIs
 * to draw where, and the addresses of plugin pages. The components are in slots.tsx.
 */
import { usePluginContributions } from './api'
import type { FramePlugin } from './host/PluginFrame'
import { type ContributionUi, type ObjectType, objectsOf, type PluginContributionsOut } from './types'

const NONE: ContributionUi[] = []

/** The UI contributions to draw, or none while loading, on error or with the kill switch on. */
export function usePluginUis(): ContributionUi[] {
  const data = usePluginContributions().data
  return data && !data.disabled_all ? data.ui : NONE
}

/** What a frame needs to know about the plugin behind a contribution. */
export function framePlugin(ui: ContributionUi): FramePlugin {
  return { id: ui.plugin, name: ui.plugin_name, iconUrl: ui.icon_url, version: ui.version }
}

/** The ids of a plugin's pages (what its frames may open with `ui.open`). */
export function pagesOf(all: ContributionUi[], pluginId: string): string[] {
  return all.filter((u) => u.plugin === pluginId && u.slot === 'page').map((u) => u.id)
}

/** The panels for an object of a type. */
export function panelsFor(all: ContributionUi[], type: ObjectType): ContributionUi[] {
  return all.filter((u) => u.slot === 'object.panel' && objectsOf(u).includes(type))
}

/** The id of a document side-panel tab for a plugin panel ("plugin:<plugin id>/<ui id>"). */
export const documentTabId = (ui: ContributionUi): string => `plugin:${ui.plugin}/${ui.id}`

/** The tabs plugins add beside a document: their ids and names. */
export function usePluginDocumentTabs(): { id: string; label: string }[] {
  return panelsFor(usePluginUis(), 'document').map((ui) => ({ id: documentTabId(ui), label: ui.title ?? ui.plugin_name }))
}

export const pluginPageLink = (pluginId: string, uiId: string): string => `/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(uiId)}`

/** The fences to register: those of enabled plugins, none with the kill switch on. */
export function activeFences(data: PluginContributionsOut | undefined): string[] {
  if (!data || data.disabled_all) return []
  return [...new Set(data.fences.map((f) => f.fence))]
}
