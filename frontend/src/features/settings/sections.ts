import { msg } from '@/lib/i18n'
import type { PageId } from './navigation'

export interface SectionLink {
  to: string
  label: string
  /** Security-sensitive sections show a shield and require re-authentication to change. */
  sensitive?: boolean
  /** Not listed once all of these pages are turned off (Settings > Pages). */
  of?: PageId[]
}

export const SETTINGS_SECTIONS: SectionLink[] = [
  { to: 'general', label: msg('General') },
  { to: 'appearance', label: msg('Appearance') },
  { to: 'pages', label: msg('Pages') },
  { to: 'focus', label: msg('Focus & music'), of: ['focus', 'music'] },
  { to: 'skills', label: msg('Skills') },
  { to: 'providers', label: msg('Providers & Models'), sensitive: true },
  { to: 'permissions', label: msg('Agent Permissions'), sensitive: true },
  { to: 'workspace', label: msg('Workspace'), sensitive: true },
  { to: 'web', label: msg('Web & Search'), sensitive: true },
  { to: 'mcp', label: msg('MCP'), sensitive: true },
  { to: 'notifications', label: msg('Notifications') },
  { to: 'memory', label: msg('Memory') },
  { to: 'sharing', label: msg('Shared links') },
  { to: 'usage', label: msg('Usage') },
  { to: 'advanced', label: msg('Advanced') },
]

/** The sections to list, given the pages that are turned off. */
export function visibleSections(off: readonly PageId[]): SectionLink[] {
  return SETTINGS_SECTIONS.filter((s) => !s.of || s.of.some((id) => !off.includes(id)))
}
