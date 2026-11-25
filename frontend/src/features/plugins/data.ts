/**
 * What a plugin made and keeps (`GET /api/plugins/{id}/data`), in the words of the Data tab
 * and the uninstall dialog (contract §5, Uninstall):
 *
 *  - `resources`: the objects its contributions registered. Those it owns are deleted when
 *    its data is removed; those it adopted (`owned: false`, e.g. a property that existed
 *    with the same type) were the user's before and stay either way.
 *  - `tasks`, `documents`, `events`: what it created through its calls; removing its data
 *    moves them to the Trash.
 *  - its own storage (`storage_keys`, `storage_bytes`): deleted when its data is removed.
 */
import { plural, t } from '@/lib/i18n'
import { CONTRIBUTION_KINDS } from './permissions'
import type { PluginDataOut, PluginResourceOut } from './types'

/** The heading of a resource's kind ("Properties"), or the manifest key for a new kind. */
export const resourceKind = (kind: string): string => (CONTRIBUTION_KINDS[kind] ? t(CONTRIBUTION_KINDS[kind]) : kind)

/** "Stage (Properties)": a resource's own name (the plugin's text, as it is) and its kind. */
export const resourceText = (r: PluginResourceOut): string => `${r.label} (${resourceKind(r.kind)})`

export const ownedResources = (data: PluginDataOut | undefined): PluginResourceOut[] => (data?.resources ?? []).filter((r) => r.owned)
export const adoptedResources = (data: PluginDataOut | undefined): PluginResourceOut[] => (data?.resources ?? []).filter((r) => !r.owned)

/** "2 tasks, 1 document": what it created, or '' when nothing. */
export function writtenText(data: PluginDataOut | undefined): string {
  if (!data) return ''
  const parts: string[] = []
  if (data.tasks > 0) parts.push(plural(data.tasks, '{n} task', '{n} tasks'))
  if (data.documents > 0) parts.push(plural(data.documents, '{n} document', '{n} documents'))
  if (data.events > 0) parts.push(plural(data.events, '{n} event', '{n} events'))
  return parts.join(', ')
}

/** True when there is nothing to show. */
export const isEmpty = (data: PluginDataOut): boolean =>
  data.resources.length === 0 && data.tasks + data.documents + data.events === 0 && data.storage_keys === 0
