/**
 * The plugins API's shapes, from the generated schema (`make gen-api`), plus the few
 * narrower types the UI needs where the server's model is looser than what it sends:
 *
 *  - a version's manifest is stored as plain JSON (`dict` on the server): `manifestOf()`
 *    reads it as a `Manifest` (the server validated it before storing it);
 *  - a contributed UI's `slot`/`objects` are strings on the wire: `Slot`/`ObjectType` name
 *    the values the contract allows;
 *  - a command's `action` is an untyped object: `commandAction()` narrows it.
 */
import type { Schemas } from '@/api/client'

export type PluginOut = Schemas['PluginOut']
export type PluginListOut = Schemas['PluginListOut']
export type PluginSource = Schemas['PluginSource']
export type PluginDetailOut = Schemas['PluginDetailOut']
export type PluginVersionOut = Schemas['PluginVersionOut']
export type PermissionOut = Schemas['PermissionOut']
export type ContributionOut = Schemas['ContributionOut']
export type PluginFileOut = Schemas['PluginFileOut']
export type PluginDiffOut = Schemas['PluginDiffOut']
export type PluginDiffFile = Schemas['DiffFileOut']
export type PluginFrameBundleOut = Schemas['PluginFrameBundleOut']
export type PluginDataOut = Schemas['PluginDataOut']
export type PluginResourceOut = Schemas['PluginResourceOut']
export type PluginContributionsOut = Schemas['PluginContributionsOut']
export type ContributionUi = Schemas['ContributedUiOut']
export type ContributionCommand = Schemas['ContributedCommandOut']
export type ContributionFence = Schemas['ContributedFenceOut']
export type BundledPluginOut = Schemas['BundledPluginOut']
/** The body of a plugin call (contract §7). `ui` is null for a command from Ctrl+K. */
export type PluginCallBody = Schemas['PluginCallIn']

/** Who made a version (the same shape as everywhere else that names an actor). */
export type ActorOut = Schemas['ActorOut']

export type Risk = PermissionOut['risk']
export type PluginStatus = PluginOut['status']
export type VersionStatus = PluginVersionOut['status']
export type Slot = 'object.panel' | 'page' | 'settings' | 'chat.block' | 'overlay'
export type ObjectType = 'task' | 'document' | 'event'

const OBJECT_TYPES: readonly string[] = ['task', 'document', 'event']

/** The object types a contributed panel is for (the server sends them as strings). */
export const objectsOf = (ui: Pick<ContributionUi, 'objects'>): ObjectType[] =>
  (ui.objects ?? []).filter((o): o is ObjectType => OBJECT_TYPES.includes(o))

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

/** A version's manifest. The schema types it as a plain object; the server validated it. */
export const manifestOf = (version: Pick<PluginVersionOut, 'manifest'>): Manifest => version.manifest as unknown as Manifest

/** A command's action (contract §2.2 `commands`). */
export type CommandAction =
  | { type: 'openPage'; page: string }
  | { type: 'runScript'; script: string; input?: unknown }
  | { type: 'newFromTemplate'; template: string }
  | { type: 'sendToUi'; ui: string; event: string }

/** The command's action, or null for one this version of the app doesn't know. */
export function commandAction(action: ContributionCommand['action']): CommandAction | null {
  if (action.type === 'openPage' && typeof action.page === 'string') return { type: 'openPage', page: action.page }
  if (action.type === 'runScript' && typeof action.script === 'string') return { type: 'runScript', script: action.script, input: action.input }
  if (action.type === 'newFromTemplate' && typeof action.template === 'string') return { type: 'newFromTemplate', template: action.template }
  if (action.type === 'sendToUi' && typeof action.ui === 'string' && typeof action.event === 'string') return { type: 'sendToUi', ui: action.ui, event: action.event }
  return null
}
