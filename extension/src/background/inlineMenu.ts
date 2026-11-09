/**
 * Right-click Explain / Translate / Translate page: injects the in-page script into the
 * frame that was clicked (once per page) and calls it. Where nothing can be injected
 * (Chrome's PDF viewer, its own pages), the answer is shown in the side panel instead.
 */
import { withDefaults } from '@/shared/preferences'
import { storage } from '@/shared/storage'
import { streamExplain, translate } from './inline'

type Call = 'explain' | 'translateSelection' | 'translatePage'

async function rememberInjected(tabId: number): Promise<void> {
  const tabs = (await storage.get('session', 'injectedTabs')) ?? []
  if (!tabs.includes(tabId)) await storage.set('session', 'injectedTabs', [...tabs, tabId].slice(-200))
}

/** Runs one of the in-page functions; false when the frame can't be scripted. */
export async function callInPage(tabId: number, frameId: number, call: Call | 'restoreAll', language?: string): Promise<boolean> {
  const target = { tabId, frameIds: [frameId] }
  try {
    const [probe] = await chrome.scripting.executeScript({ target, func: () => Boolean((window as unknown as { __anemoInline?: unknown }).__anemoInline) })
    if (!probe?.result) await chrome.scripting.executeScript({ target, files: ['inpage/inline.js'] })
    await rememberInjected(tabId)
    await chrome.scripting.executeScript({
      target,
      func: (name: string, lang: string | null) => {
        const api = (window as unknown as { __anemoInline: Record<string, (l?: string) => unknown> }).__anemoInline
        api[name](lang ?? undefined)
      },
      args: [call, language ?? null],
    })
    return true
  } catch {
    return false
  }
}

/** Pages no script can run in: show the answer in the panel. Decided from the click itself,
 *  so the panel can still be opened (only possible during the click). */
function unscriptable(info: chrome.contextMenus.OnClickData): boolean {
  const frame = info.frameUrl ?? info.pageUrl ?? ''
  return /^(chrome|chrome-extension|edge|about|devtools|view-source):/i.test(frame) || /\.pdf(?:$|[?#])/i.test(info.pageUrl ?? '')
}

const THROTTLE_MS = 150

/** The explanation or translation, in the panel (written to session storage as it comes). */
async function inPanel(mode: 'explain' | 'translate', selection: string, language: string, url: string): Promise<void> {
  const id = `p${Date.now()}`
  const base = { id, mode, selection, at: Date.now() }
  await storage.set('session', 'panelInline', { ...base, text: '', status: 'working' })
  try {
    if (mode === 'translate') {
      const text = await translate(selection.slice(0, 12_000), language)
      await storage.set('session', 'panelInline', { ...base, text, status: 'done' })
      return
    }
    let text = ''
    let last = 0
    await streamExplain(
      { text: selection.slice(0, 4000), context: '', url, title: '', target_language: language, breakdown: selection.split(/\s+/).length <= 8 },
      (delta) => {
        text += delta
        if (Date.now() - last > THROTTLE_MS) {
          last = Date.now()
          void storage.set('session', 'panelInline', { ...base, text, status: 'working' })
        }
      },
    )
    await storage.set('session', 'panelInline', { ...base, text, status: 'done' })
  } catch (err) {
    await storage.set('session', 'panelInline', { ...base, text: '', status: 'error', error: (err as Error).message })
  }
}

export function onInlineClick(id: string, info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab): void {
  const [kind, code] = id.split(':')
  const panelOnly = unscriptable(info)
  if (panelOnly && tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined)
  void (async () => {
    const language = code ?? withDefaults(await storage.get('local', 'preferences')).targetLanguage
    const mode = kind === 'anemo-explain' ? 'explain' : 'translate'
    if (kind === 'anemo-translate-page') {
      if (panelOnly || !(await callInPage(tab.id!, info.frameId ?? 0, 'translatePage', language))) {
        await storage.set('session', 'panelNotice', { title: 'This page can’t be translated in place', body: 'Chrome doesn’t let extensions change its own pages or its PDF viewer. Select text and use Translate to read it in the panel.', at: Date.now() })
      }
      return
    }
    const selection = info.selectionText ?? ''
    if (!panelOnly && (await callInPage(tab.id!, info.frameId ?? 0, mode === 'explain' ? 'explain' : 'translateSelection', language))) return
    // No box possible here: the answer goes to the panel.
    if (!panelOnly) {
      await storage.set('session', 'panelNotice', { title: 'Shown in the Anemo panel', body: 'This page doesn’t allow a box. Click the Anemo toolbar icon to see the answer.', at: Date.now() })
    }
    if (selection) await inPanel(mode, selection, language, info.pageUrl ?? '')
  })()
}
