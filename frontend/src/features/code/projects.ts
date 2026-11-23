/**
 * Project names for starting a Claude Code job (docs/specs/code-sessions.md §12.1,
 * §12.5): the same rule as Anemo Desktop and the server, and whether a computer already
 * has a project of that name. Pure.
 */
import type { CodeProjects } from './api'

const NAME = /^[A-Za-z0-9._-]{1,100}$/
/** Windows device names: not usable as a folder, with or without an extension ("nul.txt"). */
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** A folder name Anemo Desktop accepts: no path, not only dots, no dot at the end, no device name. */
export function validProjectName(name: string): boolean {
  if (!NAME.test(name)) return false
  if (/^\.+$/.test(name) || name.endsWith('.')) return false
  return !DEVICE.test(name.split('.')[0])
}

/** The repository name in a remote address: "https://github.com/o/anemo.git" or "git@github.com:o/anemo" → "anemo". */
export function repoName(url: string | null | undefined): string | undefined {
  const last = url?.trim().replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/i, '')
  return last || undefined
}

/**
 * Whether the computer would find a project of this name without creating one: a
 * folder of that name, a folder whose origin is a repository of that name, or one of
 * the owner's repositories not cloned yet (folders on Windows ignore case).
 */
export function knownProject(projects: CodeProjects | undefined, name: string): boolean {
  if (!projects) return false
  const lower = name.toLowerCase()
  return (
    projects.projects.some((p) => p.name.toLowerCase() === lower || repoName(p.remote)?.toLowerCase() === lower) ||
    projects.remote.some((r) => r.name.toLowerCase() === lower)
  )
}
