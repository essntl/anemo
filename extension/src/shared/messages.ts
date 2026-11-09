/**
 * Messages between the extension's parts, and who may send what.
 *
 * Web pages can't message the extension at all (no `externally_connectable`). Our own
 * in-page scripts can, so every message is checked: it must come from this extension
 * (`sender.id`), and a message from a tab only counts when we injected a script into that
 * tab and the message type is one an in-page script may send. Nothing that changes state
 * is accepted from a tab without a click in the panel or a user-triggered context menu.
 */

/** From the side panel or another extension page to the worker. */
export type PanelMessage =
  | { type: 'panel.opened' }
  | { type: 'connection.changed' }
  | { type: 'features.changed' }

/** From one of our in-page scripts to the worker. Kept short on purpose. */
export type InpageMessage = { type: 'inpage.ready'; script: string }

export type Message = PanelMessage | InpageMessage

const INPAGE_TYPES = new Set<string>(['inpage.ready'])
const PANEL_TYPES = new Set<string>(['panel.opened', 'connection.changed', 'features.changed'])

export type SenderKind = 'extension_page' | 'inpage' | 'rejected'

/** Where a message came from, or 'rejected' when it must be ignored. */
export function classifySender(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  ownId: string,
  injectedTabs: readonly number[],
): SenderKind {
  if (sender.id !== ownId) return 'rejected'
  const type = typeof message === 'object' && message !== null ? (message as { type?: unknown }).type : undefined
  if (typeof type !== 'string') return 'rejected'
  if (sender.tab === undefined) {
    // The side panel and our other pages: their URL is inside the extension.
    const ownPage = typeof sender.url === 'string' && sender.url.startsWith(`chrome-extension://${ownId}/`)
    return ownPage && PANEL_TYPES.has(type) ? 'extension_page' : 'rejected'
  }
  const tabId = sender.tab.id
  if (tabId === undefined || !injectedTabs.includes(tabId)) return 'rejected'
  return INPAGE_TYPES.has(type) ? 'inpage' : 'rejected'
}
