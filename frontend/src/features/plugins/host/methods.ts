/**
 * The methods a plugin frame may call (contract §6.3) and the permission each needs.
 *
 * This is the host's own check, in the page, before a call goes to the server: it gives a
 * quick, clear error. The server checks every call again against the version it has
 * approved; that check is the one that counts (contract, "checked by the host, twice").
 *
 * Error messages here are for the plugin's author (they reach the plugin's code, not the
 * user), so they are English and not translated.
 */

/** The error codes a frame can get back (contract §6.3). */
export type FrameErrorCode =
  | 'permission_denied'
  | 'not_found'
  | 'invalid_params'
  | 'declined'
  | 'rate_limited'
  | 'unavailable'
  | 'failed'
  | 'unknown_method'

export interface FrameError {
  code: FrameErrorCode
  message: string
}

type Need =
  /** Anyone: no permission (the plugin's own storage and context). */
  | { kind: 'none' }
  /** Answered by the page itself (ui.*, context.get). */
  | { kind: 'local' }
  | { kind: 'permission'; permission: string; what: string }
  /** One of these is enough (templates.apply: a document or a task template). */
  | { kind: 'any'; permissions: string[]; what: string }
  /** `network:<host of params.url>`. */
  | { kind: 'network' }
  /** `tools:<params.name>`. */
  | { kind: 'tool' }
  /** The server checks that the script is this plugin's. */
  | { kind: 'own' }

const read = (area: string, what: string): Need => ({ kind: 'permission', permission: `${area}:read`, what })
const write = (area: string, what: string): Need => ({ kind: 'permission', permission: `${area}:write`, what })

export const METHODS: Record<string, Need> = {
  'context.get': { kind: 'local' },
  'storage.get': { kind: 'none' },
  'storage.set': { kind: 'none' },
  'storage.delete': { kind: 'none' },
  'storage.list': { kind: 'none' },
  'tasks.list': read('tasks', 'read tasks'),
  'tasks.get': read('tasks', 'read tasks'),
  'tasks.create': write('tasks', 'create or change tasks'),
  'tasks.update': write('tasks', 'create or change tasks'),
  'documents.list': read('documents', 'read documents'),
  'documents.search': read('documents', 'read documents'),
  'documents.get': read('documents', 'read documents'),
  'documents.create': write('documents', 'create or change documents'),
  'documents.update': write('documents', 'create or change documents'),
  'events.list': read('events', 'read calendar events'),
  'events.get': read('events', 'read calendar events'),
  'events.create': write('events', 'create or change calendar events'),
  'events.update': write('events', 'create or change calendar events'),
  'projects.list': read('projects', 'list projects'),
  'notifications.send': { kind: 'permission', permission: 'notifications:send', what: 'send notifications' },
  'http.fetch': { kind: 'network' },
  'tools.call': { kind: 'tool' },
  'scripts.run': { kind: 'own' },
  'templates.apply': { kind: 'any', permissions: ['documents:write', 'tasks:write'], what: 'create documents or tasks from templates' },
  'ui.resize': { kind: 'local' },
  'ui.toast': { kind: 'local' },
  'ui.open': { kind: 'local' },
}

export const isLocal = (method: string): boolean => METHODS[method]?.kind === 'local'

/** Whether `host` is covered by a `network:` permission (`*.example.com` = its subdomains). */
export function hostAllowed(host: string, permissions: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return permissions.some((p) => {
    if (!p.startsWith('network:')) return false
    const allowed = p.slice('network:'.length).toLowerCase()
    if (allowed.startsWith('*.')) return h.endsWith(allowed.slice(1)) && h.length > allowed.length - 1
    return h === allowed
  })
}

const denied = (message: string): FrameError => ({ code: 'permission_denied', message })
const invalid = (message: string): FrameError => ({ code: 'invalid_params', message })

/**
 * Check a call against the permissions of the version that runs (or the preview's). Returns
 * null when the call may go on, or the error to answer with.
 */
export function checkCall(method: string, params: unknown, permissions: readonly string[]): FrameError | null {
  const need = METHODS[method]
  if (!need) return { code: 'unknown_method', message: `There is no method "${method}".` }
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
  switch (need.kind) {
    case 'none':
    case 'local':
    case 'own':
      return null
    case 'permission':
      return permissions.includes(need.permission) ? null : denied(`This plugin may not ${need.what} (it needs "${need.permission}").`)
    case 'any':
      return need.permissions.some((x) => permissions.includes(x)) ? null : denied(`This plugin may not ${need.what}.`)
    case 'network': {
      if (typeof p.url !== 'string') return invalid('http.fetch needs a "url".')
      let url: URL
      try {
        url = new URL(p.url)
      } catch {
        return invalid(`"${p.url}" is not a valid address.`)
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return invalid('http.fetch only fetches http and https addresses.')
      return hostAllowed(url.hostname, permissions) ? null : denied(`This plugin may not reach ${url.hostname} (it needs "network:${url.hostname}").`)
    }
    case 'tool': {
      if (typeof p.name !== 'string' || !p.name) return invalid('tools.call needs a tool "name".')
      return permissions.includes(`tools:${p.name}`) ? null : denied(`This plugin may not call the tool ${p.name} (it needs "tools:${p.name}").`)
    }
  }
}

/** The read permission `ui.open` needs to open an object of a type. */
export const OPEN_NEEDS: Record<string, string> = { task: 'tasks:read', document: 'documents:read', event: 'events:read' }
