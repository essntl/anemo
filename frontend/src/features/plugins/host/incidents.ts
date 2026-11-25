/**
 * Frames that Anemo removed because they navigated away (contract §6.2, step 3), per plugin,
 * for this visit. The plugin's page in Settings > Plugins shows them, so the user learns
 * that a plugin tried to leave its box (which could have carried data out in the address).
 */
import { create } from 'zustand'

export interface FrameIncident {
  ui: string
  at: number
}

interface IncidentStore {
  byPlugin: Record<string, FrameIncident[]>
  report: (pluginId: string, ui: string) => void
}

export const useFrameIncidents = create<IncidentStore>((set) => ({
  byPlugin: {},
  report: (pluginId, ui) =>
    set((s) => ({ byPlugin: { ...s.byPlugin, [pluginId]: [...(s.byPlugin[pluginId] ?? []), { ui, at: Date.now() }] } })),
}))

const NONE: FrameIncident[] = []

/** The removed frames of one plugin (empty when there were none). */
export function usePluginIncidents(pluginId: string): FrameIncident[] {
  return useFrameIncidents((s) => s.byPlugin[pluginId] ?? NONE)
}
