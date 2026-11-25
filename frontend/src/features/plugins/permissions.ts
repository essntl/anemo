/**
 * How the app explains a plugin's permissions and contributions, in the user's language.
 *
 * The server sends its own English label and explanation with every permission (for the
 * assistant's tools); the app shows these translated texts per permission kind instead,
 * and falls back to the server's text for a kind it doesn't know yet (contract §7).
 */
import { msg, t } from '@/lib/i18n'
import type { ContributionOut, PermissionOut, Risk } from './types'

export const RISKS: Risk[] = ['low', 'medium', 'high', 'critical']

/** The four groups of the review, from harmless to "asks every time" (contract §4.1). */
export const RISK_GROUPS: Record<Risk, { title: string; description: string; tone: 'neutral' | 'accent' | 'warning' | 'error' }> = {
  low: { title: msg('Read-only'), description: msg('It can look at these, but not change them.'), tone: 'neutral' },
  medium: { title: msg('Writes your data'), description: msg('It can create and change these. Deleting goes to the Trash.'), tone: 'accent' },
  high: { title: msg('Network, notifications, tools'), description: msg('It can reach outside Anemo or use agent tools.'), tone: 'warning' },
  critical: { title: msg('Devices, shell, computer: asks every time'), description: msg('Granted, but every single use shows you a confirmation first.'), tone: 'error' },
}

/** A short word for a risk, for badges. */
export const RISK_LABELS: Record<Risk, string> = {
  low: msg('Low risk'),
  medium: msg('Medium risk'),
  high: msg('High risk'),
  critical: msg('Critical'),
}

/**
 * The contract's warning about read permissions (§4, spec 12 §4 "Limits"): a sandboxed
 * frame can still navigate itself away, carrying data in the address. Shown next to them.
 */
export const READ_WARNING = msg('What a plugin can read, a malicious plugin could send out. Grant read access only to plugins you trust, and keep it narrow.')

const KNOWN: Record<string, { label: string; explanation: string }> = {
  'tasks:read': { label: msg('Read your tasks'), explanation: msg('List and read your tasks, and the projects they are in.') },
  'documents:read': { label: msg('Read your documents'), explanation: msg('List, search and read your documents.') },
  'events:read': { label: msg('Read your calendar'), explanation: msg('List and read your calendar events.') },
  'projects:read': { label: msg('See your projects'), explanation: msg('List your projects by name and colour.') },
  'tasks:write': { label: msg('Create and change tasks'), explanation: msg('Add tasks and change them. A task it deletes goes to the Trash.') },
  'documents:write': { label: msg('Create and change documents'), explanation: msg('Write new documents and change existing ones. Every change is kept in the document’s history.') },
  'events:write': { label: msg('Create and change events'), explanation: msg('Add calendar events and change them. An event it deletes goes to the Trash.') },
  'notifications:send': { label: msg('Send you notifications'), explanation: msg('Show notifications in your Inbox and on your devices.') },
}

/** The label and explanation to show for a permission. */
export function permissionText(p: PermissionOut): { label: string; explanation: string } {
  if (p.kind === 'network' && p.target) {
    const wildcard = p.target.startsWith('*.')
    return {
      label: wildcard ? t('Reach any address under {host}', { host: p.target.slice(2) }) : t('Reach {host}', { host: p.target }),
      explanation: t('Anemo’s server sends its requests there and hands back the answers. Whatever it can read, it could send to this address.'),
    }
  }
  if (p.kind === 'tools' && p.target) {
    return p.risk === 'critical'
      ? { label: t('Use the tool {tool}', { tool: p.target }), explanation: t('This tool acts on a device, a shell or a computer. Every call asks you first, every time.') }
      : { label: t('Use the tool {tool}', { tool: p.target }), explanation: t('Call this agent tool, with everything the tool can do.') }
  }
  const known = KNOWN[p.kind]
  return known ? { label: t(known.label), explanation: t(known.explanation) } : { label: p.label, explanation: p.explanation }
}

/** Permissions grouped by risk, in the order of RISKS, leaving out empty groups. */
export function groupByRisk<T extends { risk: Risk }>(items: T[]): { risk: Risk; items: T[] }[] {
  return RISKS.map((risk) => ({ risk, items: items.filter((i) => i.risk === risk) })).filter((g) => g.items.length > 0)
}

/** True when any of them lets the plugin read your data (then READ_WARNING is shown). */
export const readsData = (permissions: PermissionOut[]): boolean => permissions.some((p) => p.kind.endsWith(':read') || p.kind === 'network')

/** What each kind of contribution is, as a heading of the Contributions list. */
export const CONTRIBUTION_KINDS: Record<string, string> = {
  ui: msg('Panels and pages'),
  commands: msg('Commands in Ctrl+K'),
  scripts: msg('Scripts'),
  automations: msg('Automations'),
  mcpServers: msg('MCP servers'),
  profiles: msg('Agent profiles'),
  skills: msg('Skills'),
  themes: msg('Themes'),
  templates: msg('Templates'),
  properties: msg('Properties'),
  views: msg('Saved views'),
}

/** The order of the Contributions list: what you see first, what runs on its own last. */
const KIND_ORDER = ['ui', 'commands', 'themes', 'templates', 'properties', 'views', 'skills', 'profiles', 'automations', 'scripts', 'mcpServers']

export function groupContributions(items: ContributionOut[]): { kind: string; title: string; items: ContributionOut[] }[] {
  const kinds = [...new Set(items.map((i) => i.kind))].sort((a, b) => (KIND_ORDER.indexOf(a) + 1 || 99) - (KIND_ORDER.indexOf(b) + 1 || 99))
  return kinds.map((kind) => ({ kind, title: CONTRIBUTION_KINDS[kind] ? t(CONTRIBUTION_KINDS[kind]) : kind, items: items.filter((i) => i.kind === kind) }))
}
