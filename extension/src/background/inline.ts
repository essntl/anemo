/**
 * The worker's side of in-page translate and explain. The in-page script connects a port
 * ("anemo-inline"); messages are accepted only from this extension, from a tab we injected
 * into, and of the known types, with their sizes checked. The worker calls Anemo with the
 * token (the page never sees it) and sends the answer back.
 */
import { authHeaders, classifyResponse, createApi, fromErrorBody, unwrap, type Api } from '@/shared/api'
import { markTokenLost } from '@/shared/connectionStore'
import { PageReadError, readPage, SAVE_CHAR_LIMIT, type PageContext } from '@/shared/pageContext'
import { failureMessage } from '@/shared/pageFailure'
import { discussDraft } from '@/shared/learning'
import { SseParser } from '@/shared/sse'
import { storage } from '@/shared/storage'

const MAX_PARALLEL = 3

async function connection() {
  const c = await storage.get('local', 'connection')
  return c?.token ? { serverUrl: c.serverUrl, token: c.token } : null
}

async function apiNow(): Promise<Api | null> {
  const c = await connection()
  return c ? createApi({ ...c, onUnauthorized: () => void markTokenLost() }) : null
}

/** Streams an explanation; calls `onDelta` with each piece. Throws with a message. */
export async function streamExplain(body: Record<string, unknown>, onDelta: (text: string) => void): Promise<void> {
  const c = await connection()
  if (!c) throw new Error('Anemo Companion isn’t connected.')
  let res: Response
  try {
    res = await fetch(`${c.serverUrl}/api/inline/explain`, {
      method: 'POST',
      credentials: 'omit',
      headers: { ...authHeaders(c.token), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('Anemo couldn’t be reached.')
  }
  const problem = await classifyResponse(res)
  if (problem) throw new Error(problem.message)
  if (!res.ok || !res.body) {
    const err = fromErrorBody(res.status, await res.json().catch(() => undefined))
    if (err.kind === 'unauthorized') void markTokenLost()
    throw new Error(err.message)
  }
  const parser = new SseParser()
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    for (const e of parser.push(value)) {
      const data = JSON.parse(e.data) as { text?: string; message?: string }
      if (e.type === 'delta' && data.text) onDelta(data.text)
      else if (e.type === 'error') throw new Error(data.message ?? 'The explanation failed.')
      else if (e.type === 'done') return
    }
  }
}

export async function translate(text: string, targetLanguage: string): Promise<string> {
  const api = await apiNow()
  if (!api) throw new Error('Anemo Companion isn’t connected.')
  return unwrap(await api.POST('/api/inline/translate', { body: { text, target_language: targetLanguage } })).text
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null)
const lang = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(v) ? v : null)

/** Hands an explanation over to the panel: a chat, or the capture form. */
async function handoff(kind: 'openChat' | 'save', tab: chrome.tabs.Tab, selection: string, explanation: string): Promise<{ ok: boolean; message?: string }> {
  const api = await apiNow()
  if (!api) return { ok: false, message: 'Anemo Companion isn’t connected.' }
  let page: PageContext
  try {
    page = await readPage(api, tab, { limit: kind === 'save' ? SAVE_CHAR_LIMIT : undefined })
  } catch (err) {
    return { ok: false, message: err instanceof PageReadError ? failureMessage(err.failure).title : 'The page couldn’t be read.' }
  }
  page = { ...page, selection }
  if (kind === 'save') {
    await storage.set('session', 'pendingCapture', { kind: 'selection', page, explanation, at: Date.now() })
    const state = await storage.get('session', 'panelState')
    await storage.set('session', 'panelState', { view: 'capture', conversationId: state?.conversationId ?? null })
  } else {
    const quoted = explanation.trim() ? `${discussDraft(selection)}Anemo explained:\n\n${discussDraft(explanation)}` : discussDraft(selection)
    await storage.set('session', 'pendingCompose', { page, draft: quoted, at: Date.now() })
    await storage.set('session', 'panelState', { view: 'chat', conversationId: null })
  }
  try {
    if (tab.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId })
    return { ok: true }
  } catch {
    // Opening the panel needs a click on the extension; it is ready when opened.
    return { ok: false, message: 'Ready in the Anemo panel: click the Anemo toolbar icon to open it.' }
  }
}

export function listenForInline(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'anemo-inline') return
    // Listen at once (the first message comes right behind the connection); handle
    // messages only once the sender is checked.
    const early: Record<string, unknown>[] = []
    let handle: ((m: Record<string, unknown>) => void) | null = null
    port.onMessage.addListener((m: Record<string, unknown>) => (handle ? handle(m) : early.push(m)))
    void (async () => {
      const tab = port.sender?.tab
      const injected = (await storage.get('session', 'injectedTabs')) ?? []
      if (port.sender?.id !== chrome.runtime.id || !tab?.id || !injected.includes(tab.id)) {
        port.disconnect()
        return
      }
      const tabId = tab.id
      let running = 0
      const waiting: (() => Promise<void>)[] = []
      const pump = () => {
        while (running < MAX_PARALLEL && waiting.length) {
          const job = waiting.shift()!
          running += 1
          void job().finally(() => {
            running -= 1
            pump()
          })
        }
      }
      const post = (m: Record<string, unknown>) => {
        try {
          port.postMessage(m)
        } catch {
          // the page went away
        }
      }
      handle = (m: Record<string, unknown>) => {
        const id = str(m.id, 40)
        switch (m.type) {
          case 'explain': {
            const text = str(m.text, 4000)
            const target = lang(m.targetLanguage)
            if (!id || !text || !target) return
            void streamExplain(
              {
                text,
                context: str(m.context, 4000) ?? '',
                url: str(m.url, 2000) ?? '',
                title: str(m.title, 300) ?? '',
                target_language: target,
                breakdown: m.breakdown === true,
              },
              (delta) => post({ type: 'delta', id, text: delta }),
            ).then(
              () => post({ type: 'done', id }),
              (err: Error) => post({ type: 'error', id, message: err.message }),
            )
            break
          }
          case 'translate': {
            const text = str(m.text, 12_000)
            const target = lang(m.targetLanguage)
            if (!id || !text || !target) return
            waiting.push(() =>
              translate(text, target).then(
                (out) => post({ type: 'translated', id, text: out }),
                (err: Error) => post({ type: 'error', id, message: err.message }),
              ),
            )
            pump()
            break
          }
          case 'openChat':
          case 'save': {
            const selection = str(m.selection, 100_000)
            const explanation = str(m.explanation, 40_000) ?? ''
            if (!selection) return
            void handoff(m.type, tab, selection, explanation).then((r) => post({ type: 'handoff', ...r }))
            break
          }
          case 'status': {
            const n = typeof m.translated === 'number' && m.translated >= 0 ? Math.floor(m.translated) : 0
            void storage.get('session', 'translatedTabs').then((all) => storage.set('session', 'translatedTabs', { ...(all ?? {}), [String(tabId)]: n }))
            break
          }
          default:
            break
        }
      }
      for (const m of early.splice(0)) handle(m)
    })()
  })
}
