/**
 * Plugins in the search box (Ctrl+K): their pages ("Go to") and their commands ("Actions"),
 * offered once something matching is typed, like the built-in actions. A command is one of
 * the three declarative actions of the contract (§2.2 `commands`):
 *
 *  - `openPage`: goes to one of the plugin's pages;
 *  - `runScript`: starts one of its scripts (the result comes later, in the run history);
 *  - `newFromTemplate`: creates a document or task from one of its templates and offers to open it.
 *
 * The last two are calls like a frame's (`scripts.run`, `templates.apply`), checked by the
 * server, and asking first when the server says so.
 */
import type { ReactNode } from 'react'
import { errorMessage } from '@/api/client'
import { toast } from '@/components/ui/toast'
import { documentLink, eventLink, taskLink } from '@/lib/appLinks'
import { t } from '@/lib/i18n'
import { callPlugin, usePluginContributions } from './api'
import { callWithConfirm } from './host/channel'
import { confirmPluginCall } from './host/confirm'
import { NamedIcon, PluginIcon } from './PluginIcon'
import { pluginPageLink } from './slotData'
import { commandAction, type ContributionCommand, type ContributionUi, type PluginContributionsOut } from './types'

export interface PluginPaletteItem {
  key: string
  title: string
  /** The plugin's name, under the title. */
  detail: string
  iconNode: ReactNode
  /** A page to go to… */
  to?: string
  /** …or something to do. */
  run?: (navigate: (to: string) => void) => void
}

/** An icon from Anemo's set by name, with the plugin's own picture when the name is unknown. */
const iconNode = (name: string | null, iconUrl: string | null) => (
  <NamedIcon name={name} className="h-[18px] w-[18px]" fallback={<PluginIcon url={iconUrl} size={18} className="rounded-md" />} />
)

const matches = (words: string[], text: string) => {
  const hay = text.toLowerCase()
  return words.every((w) => hay.includes(w))
}

/** Carry out a command (see the top of this file). */
export async function runCommand(command: ContributionCommand, iconUrl: string | null, navigate: (to: string) => void): Promise<void> {
  const action = commandAction(command.action)
  if (!action) {
    toast({ message: t('{name}: this command needs a newer version of Anemo.', { name: command.plugin_name }) })
    return
  }
  if (action.type === 'openPage') {
    navigate(pluginPageLink(command.plugin, action.page))
    return
  }
  const confirm = (request: Parameters<typeof confirmPluginCall>[1]) =>
    confirmPluginCall({ id: command.plugin, name: command.plugin_name, iconUrl }, request)
  try {
    if (action.type === 'runScript') {
      await callWithConfirm({ ui: null, method: 'scripts.run', params: { script: action.script, input: action.input ?? null } }, (body) => callPlugin(command.plugin, body), confirm)
      toast({ message: t('“{title}” started. Its result will be in the run history.', { title: command.title }) })
      return
    }
    const made = (await callWithConfirm({ ui: null, method: 'templates.apply', params: { template: action.template } }, (body) => callPlugin(command.plugin, body), confirm)) as { type?: string; id?: string } | null
    const link = made?.id ? (made.type === 'task' ? taskLink(made.id) : made.type === 'event' ? eventLink(made.id) : documentLink(made.id)) : null
    toast({ message: t('Created from “{title}”.', { title: command.title }), action: link ? { label: t('Open'), onClick: () => navigate(link) } : undefined })
  } catch (err) {
    toast({ message: t('{name}: {problem}', { name: command.plugin_name, problem: errorMessage(err) }) })
  }
}

/** The pages and commands that match what is typed (nothing before anything is typed). */
export function pluginPaletteItems(data: PluginContributionsOut | undefined, query: string): { actions: PluginPaletteItem[]; pages: PluginPaletteItem[] } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!data || data.disabled_all || words.length === 0) return { actions: [], pages: [] }
  const pictures = new Map<string, string | null>(data.ui.map((u) => [u.plugin, u.icon_url]))
  const pages = data.ui
    .filter((u: ContributionUi) => u.slot === 'page' && matches(words, `${u.title ?? ''} ${u.plugin_name}`))
    .map((u) => ({
      key: `plugin-page:${u.plugin}/${u.id}`,
      title: u.title ?? u.plugin_name,
      detail: u.plugin_name,
      iconNode: iconNode(u.icon, u.icon_url),
      to: pluginPageLink(u.plugin, u.id),
    }))
  const actions = data.commands
    .filter((c) => matches(words, `${c.title} ${c.keywords.join(' ')} ${c.plugin_name}`))
    .map((c) => ({
      key: `plugin-command:${c.plugin}/${c.id}`,
      title: c.title,
      detail: c.plugin_name,
      iconNode: iconNode(c.icon, pictures.get(c.plugin) ?? null),
      run: (navigate: (to: string) => void) => void runCommand(c, pictures.get(c.plugin) ?? null, navigate),
    }))
  return { actions, pages }
}

/** The plugin entries for the search box, kept in step with the enabled plugins. */
export function usePluginPalette(query: string): { actions: PluginPaletteItem[]; pages: PluginPaletteItem[] } {
  return pluginPaletteItems(usePluginContributions().data, query)
}
