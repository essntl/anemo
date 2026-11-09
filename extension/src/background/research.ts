/**
 * Research sessions in the worker: the badge dot and the "Add to research" menu entry follow
 * the active session; the menu entry and Alt+Shift+R add the page (or the selection) to it.
 */
import { unwrap, type Api } from '@/shared/api'
import { storage } from '@/shared/storage'
import { updateBadge } from './badge'

export const RESEARCH_MENU = 'anemo-add-to-research'

/** Reads the active session from Anemo and updates the badge, the menu and the panel. */
export async function refreshResearch(api: Api | null): Promise<void> {
  let active: { id: string; topic: string } | null = null
  if (api) {
    try {
      const found = unwrap(await api.GET('/api/research/sessions')).find((s) => s.status === 'active')
      active = found ? { id: found.id, topic: found.topic } : null
    } catch {
      return // keep what we had: it was right a moment ago
    }
  }
  await storage.set('session', 'researchActive', active)
  await storage.set('session', 'researchVersion', ((await storage.get('session', 'researchVersion')) ?? 0) + 1)
  await updateBadge({ research: active !== null })
  showMenu(active !== null)
}

export function showMenu(visible: boolean): void {
  chrome.contextMenus.update(RESEARCH_MENU, { visible }, () => void chrome.runtime.lastError)
}
