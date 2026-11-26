/**
 * The plugin frames open in this tab, by plugin, so the host can reach a plugin's other
 * frames:
 *
 *  - `storage.changed` / `assets.changed`: one frame wrote; the plugin's other frames are
 *    told which key, so e.g. its settings tab can change something and its overlay follows
 *    without polling;
 *  - a `sendToUi` command (Ctrl+K) delivers `command` to one of the plugin's frames.
 *
 * Only frames of the same plugin are ever reached; a frame is never told about another
 * plugin's frames or data.
 */

/** What the registry needs of a frame's channel. */
export interface OpenFrame {
  pluginId: string
  ui: string
  emit: (event: string, data: unknown) => void
}

const open = new Set<OpenFrame>()

/** Registers an open frame. Returns a function that removes it again. */
export function registerFrame(frame: OpenFrame): () => void {
  open.add(frame)
  return () => {
    open.delete(frame)
  }
}

/** The open frames of a plugin (all of them, or those of one UI). */
export function openFrames(pluginId: string, ui?: string): OpenFrame[] {
  return [...open].filter((f) => f.pluginId === pluginId && (ui === undefined || f.ui === ui))
}

/** Tells the plugin's frames other than `from` that one of its keys was written. */
export function announceWrite(from: OpenFrame, area: 'storage' | 'assets', key: string): void {
  for (const frame of openFrames(from.pluginId)) {
    if (frame !== from) frame.emit(`${area}.changed`, { key })
  }
}

/** Delivers a command's event to the plugin's open frames of that UI; false when none is open. */
export function sendToUi(pluginId: string, ui: string, event: string): boolean {
  const frames = openFrames(pluginId, ui)
  frames.forEach((frame) => frame.emit('command', { event }))
  return frames.length > 0
}
