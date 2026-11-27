import type { ToolCallView } from './api'

/** What the approval of a command on a computer offers (backend Action.device, spec 25 §6.2). */
export interface DeviceOptions {
  device_id: string
  device_name: string
  rule: string
  effects: { kind: string; path: string }[]
  unknown: string[]
  folder: string | null
  parent_folder: string | null
  scopes: ('once' | 'folder' | 'hour' | 'command')[]
}

/** The device options of a call, when it is a command on a computer that can say what it does. */
export function deviceOptions(call: ToolCallView): DeviceOptions | null {
  for (const action of call.actions) {
    const device = (action as { device?: unknown }).device
    if (device && typeof device === 'object') return device as DeviceOptions
  }
  return null
}
