/**
 * The right-click menu. Chrome groups an extension's entries under its name, so they read
 * "Anemo Companion ▸ Summarize page" and so on. A click grants access to that tab
 * (activeTab), so these work on any site without other permissions.
 */
import { createApi, type Api } from '@/shared/api'
import { markTokenLost } from '@/shared/connectionStore'
import { discussDraft, startLearningChat, type LearningAction } from '@/shared/learning'
import { PageReadError, readPage, SAVE_CHAR_LIMIT } from '@/shared/pageContext'
import { failureMessage } from '@/shared/pageFailure'
import { storage } from '@/shared/storage'

export const MENU = {
  summarize: 'anemo-summarize',
  quiz: 'anemo-quiz',
  discuss: 'anemo-discuss',
  savePage: 'anemo-save-page',
  saveSelection: 'anemo-save-selection',
  task: 'anemo-task',
} as const

export function createMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU.discuss, title: 'Discuss in chat', contexts: ['selection'] })
    chrome.contextMenus.create({ id: MENU.saveSelection, title: 'Save selection to Anemo', contexts: ['selection'] })
    chrome.contextMenus.create({ id: MENU.summarize, title: 'Summarize page', contexts: ['page', 'selection'] })
    chrome.contextMenus.create({ id: MENU.quiz, title: 'Quiz me on this page', contexts: ['page', 'selection'] })
    chrome.contextMenus.create({ id: MENU.savePage, title: 'Save page to Anemo', contexts: ['page', 'selection'] })
    chrome.contextMenus.create({ id: MENU.task, title: 'Create a task from this', contexts: ['page', 'selection'] })
  })
}

const CAPTURE: Record<string, 'page' | 'selection' | 'task'> = {
  [MENU.savePage]: 'page',
  [MENU.saveSelection]: 'selection',
  [MENU.task]: 'task',
  'save-selection': 'selection',
  'quick-task': 'task',
}

/** Read the page for a save or a task, and hand it to the panel's Capture view. */
async function prepareCapture(api: Api, kind: 'page' | 'selection' | 'task', tab: chrome.tabs.Tab): Promise<void> {
  const page = await readPage(api, tab, { limit: SAVE_CHAR_LIMIT })
  if (kind === 'selection' && !page.selection.trim()) {
    await notice('Nothing is selected', 'Select some text on the page first.')
    return
  }
  await storage.set('session', 'pendingCapture', { kind, page, at: Date.now() })
  const state = await storage.get('session', 'panelState')
  await storage.set('session', 'panelState', { view: 'capture', conversationId: state?.conversationId ?? null })
}

async function currentApi(): Promise<Api | null> {
  const connection = await storage.get('local', 'connection')
  if (!connection?.token) return null
  return createApi({ serverUrl: connection.serverUrl, token: connection.token, onUnauthorized: () => void markTokenLost() })
}

async function notice(title: string, body: string): Promise<void> {
  await storage.set('session', 'panelNotice', { title, body, at: Date.now() })
}

async function openChat(conversationId: string): Promise<void> {
  const chat = await storage.get('local', 'chat')
  await storage.set('local', 'chat', { conversationId, drafts: chat?.drafts ?? {} })
  await storage.set('session', 'panelState', { view: 'chat', conversationId })
}

async function handle(id: string, tab: chrome.tabs.Tab): Promise<void> {
  const api = await currentApi()
  if (!api) return // the panel shows setup
  try {
    if (id in CAPTURE) {
      await prepareCapture(api, CAPTURE[id], tab)
      return
    }
    if (id === MENU.discuss) {
      const page = await readPage(api, tab)
      await storage.set('session', 'pendingCompose', { page, draft: discussDraft(page.selection), at: Date.now() })
      await storage.set('session', 'panelState', { view: 'chat', conversationId: null })
      return
    }
    const action: LearningAction = id === MENU.quiz ? 'quiz' : 'summarize'
    const page = await readPage(api, tab)
    await openChat(await startLearningChat(api, page, action))
  } catch (err) {
    if (err instanceof PageReadError) {
      const text = failureMessage(err.failure)
      await notice(text.title, text.body)
    } else {
      await notice('That didn’t work', err instanceof Error ? err.message : String(err))
    }
  }
}

export function listenForMenus(): void {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.id || !Object.values(MENU).includes(info.menuItemId as never)) return
    // The panel first, while the click still counts as a user action.
    if (tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined)
    void handle(String(info.menuItemId), tab)
  })
  // Keyboard shortcuts (chrome://extensions/shortcuts); a shortcut grants access to the tab.
  chrome.commands.onCommand.addListener((command, tab) => {
    if (!tab?.id || !(command in CAPTURE)) return
    if (tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined)
    void handle(command, tab)
  })
}
