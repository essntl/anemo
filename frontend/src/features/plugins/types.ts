/**
 * The plugins API's shapes, written by hand from docs/specs/CONTRACTS-plugins.md §7.
 *
 * Workstream A builds these endpoints at the same time as this UI, so the generated
 * `schema.d.ts` doesn't have them yet. Once A is merged, `make gen-api` adds them and these
 * become aliases of `Schemas['PluginOut']` and friends. Keep every field name exactly as in
 * the contract (snake_case, as the server sends it).
 *
 * Where the contract leaves a shape open ("ui: [...]" of the contributions, the data
 * summary), the fields used here are marked "(assumed)": the UI needs them, and phase 2
 * checks them against A's real models.
 */
import type { Schemas } from '@/api/client'

export type Risk = 'low' | 'medium' | 'high' | 'critical'
export type PluginStatus = 'needs_review' | 'enabled' | 'disabled' | 'error'
export type VersionStatus = 'pending' | 'approved' | 'superseded' | 'rejected'
export type Slot = 'object.panel' | 'page' | 'settings' | 'chat.block'
export type ObjectType = 'task' | 'document' | 'event'

/** Who made a version (the same shape as everywhere else that names an actor). */
export type ActorOut = Schemas['ActorOut']

export interface PluginSource {
  kind: 'zip' | 'git' | 'assistant' | 'bundled'
  label: string
  url?: string | null
  ref?: string | null
  commit?: string | null
  conversation_ids: string[]
}

export interface PluginOut {
  /** The manifest id, e.g. "anemo.word-count". */
  id: string
  name: string
  description: string
  /** The approved version, or the newest one while none is approved. */
  version: string
  icon_url: string | null
  enabled: boolean
  status: PluginStatus
  update_pending: boolean
  made_by_assistant: boolean
  error: string | null
  source: PluginSource
  ui_count: number
  updated_at: string
}

export interface PluginListOut {
  plugins: PluginOut[]
  disabled_all: boolean
}

export interface PermissionOut {
  /** The whole string, e.g. "network:api.example.com". */
  name: string
  /** "network" or "tools" for those two, the whole name otherwise ("tasks:read"). */
  kind: string
  /** The host or tool name of a network/tools permission. */
  target: string | null
  risk: Risk
  /** The server's English text; the app shows its own translation per kind (permissions.ts). */
  label: string
  explanation: string
}

export interface ContributionOut {
  /** "ui", "commands", "scripts", "automations", "mcpServers", "profiles", "skills", "themes", "templates", "properties", "views". */
  kind: string
  id: string
  label: string
  risk: Risk
  detail: string
}

export interface PluginFileOut {
  path: string
  size: number
  sha256: string
}

/** The manifest as stored (validated by the server); only the parts the UI reads are typed. */
export interface Manifest {
  manifestVersion: number
  id: string
  version: string
  name: string
  description: string
  author?: { name: string; url?: string }
  license?: string
  icon?: string
  readme?: string
  permissions: string[]
  contributes?: {
    ui?: ManifestUi[]
    themes?: ManifestTheme[]
    scripts?: { id: string; name: string }[]
    [kind: string]: unknown
  }
}

export interface ManifestUi {
  id: string
  slot: Slot
  title?: string
  icon?: string
  entry: string
  objects?: ObjectType[]
  fence?: string
  height?: number
}

/** A theme a plugin offers (contract §2.2): a subset of Settings > Appearance, camelCase. */
export interface ManifestTheme {
  id: string
  name: string
  appearance: {
    mode?: 'light' | 'dark' | 'system'
    accent?: string
    tint?: string | null
    tintStrength?: number
    uiFont?: string
    codeFont?: string
    glass?: boolean
    glassStrength?: number
    background?: 'none' | 'gradient'
  }
}

export interface PluginVersionOut {
  version: string
  status: VersionStatus
  /** The package hash: what "Approve" names, so a newer upload in between is refused. */
  hash: string
  created_at: string
  created_by: ActorOut | null
  approved_at: string | null
  manifest: Manifest
  permissions: PermissionOut[]
  contributions: ContributionOut[]
  files: PluginFileOut[]
}

export interface PluginDetailOut extends PluginOut {
  readme: string | null
  author: { name: string; url?: string | null } | null
  license: string | null
  approved_version: string | null
  pending_version: string | null
  versions: PluginVersionOut[]
  chats: { id: string; title: string }[]
}

export interface PluginDiffFile {
  path: string
  status: 'added' | 'removed' | 'changed' | 'same'
  before?: string | null
  after?: string | null
  /** Binary files (pictures, fonts) come with their hash instead of text. */
  sha256?: string | null
}

export interface PluginDiffOut {
  from: string | null
  to: string
  manifest: { before: Manifest | null; after: Manifest }
  permissions: { added: PermissionOut[]; removed: PermissionOut[]; kept: PermissionOut[] }
  files: PluginDiffFile[]
}

/** What the host hands the frame: the entry's HTML and the files it references. */
export interface PluginFrameBundleOut {
  entry: string
  html: string
  scripts: { path: string; text: string; module?: boolean }[]
  styles: { path: string; text: string }[]
  hash: string
}

/** One thing a plugin created or keeps (assumed: the contract names the route, not the shape). */
export interface PluginDataItem {
  kind: string
  label: string
  count: number
  /** What "remove its data" does to it: deleted, or moved to the trash. */
  on_remove: 'delete' | 'trash'
}

export interface PluginDataOut {
  items: PluginDataItem[]
  storage_bytes: number
}

/** A UI contribution of an enabled plugin (assumed fields: what a slot needs to draw it). */
export interface ContributionUi {
  plugin_id: string
  plugin_name: string
  icon_url: string | null
  /** The approved version that runs. */
  version: string
  /** Its permissions, for the host's own check before a call (contract §6.4). */
  permissions: string[]
  id: string
  slot: Slot
  title: string | null
  icon: string | null
  objects: ObjectType[]
  fence: string | null
  height: number | null
}

export type CommandAction =
  | { type: 'openPage'; page: string }
  | { type: 'runScript'; script: string; input?: unknown }
  | { type: 'newFromTemplate'; template: string }

export interface ContributionCommand {
  plugin_id: string
  plugin_name: string
  id: string
  title: string
  icon: string | null
  keywords: string[]
  action: CommandAction
}

export interface ContributionFence {
  plugin_id: string
  ui: string
  fence: string
}

export interface PluginContributionsOut {
  ui: ContributionUi[]
  commands: ContributionCommand[]
  fences: ContributionFence[]
  disabled_all: boolean
}

export interface BundledPluginOut {
  id: string
  name: string
  description: string
  version: string
  icon_url: string | null
  /** Whether it is installed already (then "Install" becomes "Open"). (assumed) */
  installed: boolean
}
