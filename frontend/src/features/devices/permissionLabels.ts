import { msg, t } from '@/lib/i18n'
import type { CategoryLevel, DeviceProfile } from './api'

/** The categories of a device permission profile (docs/specs/25-device-permission-profiles.md §3). */
export const CATEGORIES = [
  { key: 'see', label: msg('See'), hint: msg('Screenshots and reading windows') },
  { key: 'act', label: msg('Act'), hint: msg('Clicks, typing, keys, opening programs, the clipboard') },
  { key: 'shell', label: msg('Shell'), hint: msg('PowerShell or zsh commands') },
  { key: 'files', label: msg('Files'), hint: msg('Copying files to and from the computer') },
  { key: 'code', label: msg('Claude Code'), hint: msg('Starting Claude Code jobs') },
] as const

export const LEVEL_LABELS: Record<CategoryLevel, string> = {
  allow: msg('Allow'),
  ask: msg('Ask'),
  deny: msg('Deny'),
  folders: msg('By work folders'),
  policy: msg('As Agent Permissions say'),
}

/** Which levels a category can have in a custom profile ("by work folders" only for shell and files). */
export const levelsFor = (category: string): CategoryLevel[] =>
  category === 'shell' || category === 'files'
    ? ['allow', 'folders', 'ask', 'deny', 'policy']
    : ['allow', 'ask', 'deny', 'policy']

export const PROTECTED_LEVEL_LABELS: Record<string, string> = {
  hard: msg('Always refused'),
  deny: msg('Refused'),
  ask: msg('Asks'),
}

/** The built-in presets' names and descriptions, by preset (custom profiles keep their own name). */
export const PRESETS: Record<string, { name: string; description: string }> = {
  unrestricted: { name: msg('Unrestricted'), description: msg('For the agent’s own VM: the whole computer is a work folder, except Anemo Desktop’s own folders.') },
  scoped: { name: msg('Scoped'), description: msg('For your own PC: the agent changes things only in the work folders; everything else is read-only.') },
  watched: { name: msg('Watched'), description: msg('Every action asks first; no shell, files or Claude Code. Looking follows your Agent Permissions.') },
  legacy: { name: msg('Trusted (legacy)'), description: msg('What a trusted computer did before profiles: everything as your Agent Permissions say. Pick Unrestricted or Scoped instead.') },
}

/** The protected folders, by key (backend features/devices/permissions.py PROTECTED). */
export const PROTECTED_LABELS: Record<string, string> = {
  anemo: msg('Anemo Desktop’s own data and install folders'),
  keys: msg('SSH, AWS and GnuPG keys'),
  browsers: msg('Browser profiles (Chrome, Edge, Firefox)'),
  credentials: msg('Windows Credential Manager and DPAPI keys'),
  startup: msg('Startup folders'),
  powershell_profiles: msg('PowerShell profile folders'),
  system: msg('Windows, Program Files and ProgramData'),
  appdata: msg('The rest of AppData'),
  roots: msg('Your user folder itself and the root of every drive'),
}

/** A profile's name as the user reads it: a preset's in their language. */
export function profileName(profile: Pick<DeviceProfile, 'name' | 'preset'>): string {
  return profile.preset && PRESETS[profile.preset] ? t(PRESETS[profile.preset].name) : profile.name
}
