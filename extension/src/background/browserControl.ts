/**
 * Browser control (feature 12): Anemo's agent using your own Chrome.
 *
 * Commands come only from Anemo over the extension's authenticated WebSocket (never from
 * pages, content scripts or other messages). The agent sees and controls only the tabs it
 * opened itself, in an "Anemo" tab group; your other tabs are invisible to it. It acts
 * through Chrome's debugger (the accessibility tree for the numbered elements, trusted
 * mouse and keyboard input, screenshots), so Chrome shows its "debugging this browser" bar
 * while it is attached.
 *
 * It is off until you switch it on in the panel, goes off again after 10 minutes without a
 * command, when the browser closes, when you press Stop, or when you cancel Chrome's
 * debugging bar. It never types into password fields, never uses a site on the blocklist
 * (or Anemo itself, or Chrome's own pages), and stops at checks for whether you are a
 * person. Which actions need your approval first is decided by Anemo before a command is
 * sent (reading and following links are free; other clicks and typing always ask).
 */
import { blockedReason, elementLine, ELEMENT_LIMIT, IDLE_OFF_MS, INTERACTIVE_ROLES, isFollowableLink, looksLikePersonCheck, TEXT_LIMIT, type ElementInfo } from '@/shared/browserControl'
import { log } from '@/shared/env'
import { withDefaults } from '@/shared/preferences'
import { storage } from '@/shared/storage'

export const IDLE_ALARM = 'anemo-browser-idle'
const GROUP_TITLE = 'Anemo'
const PROTOCOL = '1.3'
const LOAD_WAIT_MS = 10_000
const SETTLE_MS = 700

export interface Command {
  id: string
  session: string
  action: string
  url?: string
  scroll?: string
  ref?: number
  text?: string
  press_enter?: boolean
}

type Reply = (message: Record<string, unknown>) => void

class Refused extends Error {}

/** The numbered elements of each tab's last snapshot (lost when the worker restarts:
 *  the agent then reads the page again). */
const elements = new Map<number, Map<number, ElementInfo & { node: number }>>()
const attached = new Set<number>()

export async function isOn(): Promise<boolean> {
  return Boolean((await storage.get('session', 'browserActive'))?.on)
}

/** Stop at once: detach from every tab (Chrome's bar goes away) and tell Anemo. */
export async function turnOff(): Promise<void> {
  for (const tabId of [...attached]) {
    attached.delete(tabId)
    await chrome.debugger.detach({ tabId }).catch(() => undefined)
  }
  elements.clear()
  if (await storage.get('session', 'browserActive')) await storage.set('session', 'browserActive', null)
  await chrome.alarms.clear(IDLE_ALARM).catch(() => false)
}

/** Every minute while on: 10 minutes without a command switches it off. */
export async function checkIdle(): Promise<void> {
  const active = await storage.get('session', 'browserActive')
  if (active?.on && Date.now() - active.lastCommandAt > IDLE_OFF_MS) await turnOff()
}

export async function started(): Promise<void> {
  await chrome.alarms.create(IDLE_ALARM, { periodInMinutes: 1 })
}

/* ── tabs ── */

async function anemoGroup(windowId: number): Promise<number | null> {
  const [group] = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE })
  return group?.id ?? null
}

/** The session's tab: one the agent opened, still open and still in the Anemo group. */
async function tabOf(session: string): Promise<chrome.tabs.Tab | null> {
  const tabs = (await storage.get('session', 'browserTabs')) ?? {}
  const id = tabs[session]
  if (id === undefined) return null
  const tab = await chrome.tabs.get(id).catch(() => null)
  const group = tab && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? await chrome.tabGroups.get(tab.groupId).catch(() => null) : null
  if (!tab || !group || group.title !== GROUP_TITLE) {
    // Closed, or taken out of the group: it's yours again, not the agent's.
    const { [session]: _gone, ...rest } = tabs
    await storage.set('session', 'browserTabs', rest)
    if (tab) await detach(tab.id!)
    return null
  }
  return tab
}

/** A new tab for the session, in the background, in the "Anemo" group of your window. */
async function newTab(session: string): Promise<chrome.tabs.Tab> {
  const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] }).then((all) => all.filter((w) => w.focused).concat(all))
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false, ...(win?.id !== undefined ? { windowId: win.id } : {}) })
  const existing = tab.windowId !== undefined ? await anemoGroup(tab.windowId) : null
  const groupId = await chrome.tabs.group({ tabIds: [tab.id!], ...(existing !== null ? { groupId: existing } : {}) })
  if (existing === null) await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'purple' })
  const tabs = (await storage.get('session', 'browserTabs')) ?? {}
  await storage.set('session', 'browserTabs', { ...tabs, [session]: tab.id! })
  return tab
}

/* ── the debugger ── */

function send<T = Record<string, unknown>>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  return chrome.debugger.sendCommand({ tabId }, method, params) as Promise<T>
}

async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL)
  } catch (err) {
    // Still attached from before the worker restarted: carry on with it.
    if (!String(err).includes('already attached')) throw err
  }
  attached.add(tabId)
  await send(tabId, 'Page.enable')
  // Downloads only from actions you approved (see run()).
  await send(tabId, 'Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => undefined)
}

async function detach(tabId: number): Promise<void> {
  attached.delete(tabId)
  elements.delete(tabId)
  await chrome.debugger.detach({ tabId }).catch(() => undefined)
}

/** Waits for the page to finish loading if something started loading; else a moment. */
function settle(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    let loading = false
    const done = () => {
      chrome.debugger.onEvent.removeListener(listener)
      clearTimeout(long)
      clearTimeout(short)
      resolve()
    }
    const listener = (source: chrome.debugger.Debuggee, method: string) => {
      if (source.tabId !== tabId) return
      if (method === 'Page.frameStartedLoading') loading = true
      if (method === 'Page.loadEventFired') setTimeout(done, 300)
    }
    chrome.debugger.onEvent.addListener(listener)
    const long = setTimeout(done, LOAD_WAIT_MS)
    const short = setTimeout(() => {
      if (!loading) done()
    }, SETTLE_MS)
  })
}

async function navigate(tabId: number, url: string): Promise<void> {
  const waiting = settle(tabId)
  const result = await send<{ errorText?: string }>(tabId, 'Page.navigate', { url })
  if (result.errorText) throw new Refused(`The page couldn’t be opened (${result.errorText}).`)
  await waiting
}

/* ── reading the page ── */

interface PageInfo {
  url: string
  title: string
  text: string
  cut: boolean
  scroll: { y: number; height: number; viewport: number }
  frames: string[]
}

const READ_PAGE = `(() => {
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim()
  return JSON.stringify({
    url: location.href, title: document.title, text: text.slice(0, ${TEXT_LIMIT}), cut: text.length > ${TEXT_LIMIT},
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight },
    frames: [...document.querySelectorAll('iframe')].map((f) => f.src).filter(Boolean).slice(0, 50),
  })
})()`

interface AXNode {
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: unknown }
  backendDOMNodeId?: number
}

function attributesOf(flat: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; flat && i + 1 < flat.length; i += 2) out[flat[i].toLowerCase()] = flat[i + 1]
  return out
}

async function listElements(tabId: number, pageUrl: string): Promise<{ list: (ElementInfo & { node: number })[]; more: number }> {
  const { nodes } = await send<{ nodes: AXNode[] }>(tabId, 'Accessibility.getFullAXTree')
  const wanted = nodes.filter((n) => !n.ignored && n.backendDOMNodeId && INTERACTIVE_ROLES.has(n.role?.value ?? ''))
  const list: (ElementInfo & { node: number })[] = []
  for (const n of wanted.slice(0, ELEMENT_LIMIT)) {
    const role = n.role!.value!
    let attrs: Record<string, string> = {}
    let nodeName = ''
    try {
      const { node } = await send<{ node: { attributes?: string[]; nodeName?: string } }>(tabId, 'DOM.describeNode', { backendNodeId: n.backendDOMNodeId })
      attrs = attributesOf(node.attributes)
      nodeName = (node.nodeName ?? '').toLowerCase()
    } catch {
      continue // gone already
    }
    let href: string | null = null
    if (attrs.href) {
      try {
        href = new URL(attrs.href, pageUrl).href
      } catch {
        href = null
      }
    }
    const password = (nodeName === 'input' && (attrs.type ?? '').toLowerCase() === 'password') || /password/i.test(attrs.autocomplete ?? '')
    const raw = n.value?.value
    list.push({
      ref: list.length + 1,
      role,
      name: String(n.name?.value ?? ''),
      href,
      follow: isFollowableLink(role, href, attrs),
      password,
      value: !password && typeof raw === 'string' && raw ? raw : null,
      node: n.backendDOMNodeId!,
    })
  }
  return { list, more: Math.max(0, wanted.length - ELEMENT_LIMIT) }
}

async function snapshot(tabId: number, withScreenshot: boolean): Promise<Record<string, unknown>> {
  const evaluated = await send<{ result: { value?: string } }>(tabId, 'Runtime.evaluate', { expression: READ_PAGE, returnByValue: true })
  const page = JSON.parse(evaluated.result.value ?? '{}') as PageInfo
  const { list, more } = await listElements(tabId, page.url)
  elements.set(tabId, new Map(list.map((e) => [e.ref, e])))
  const botCheck = looksLikePersonCheck(page.text, page.frames)
  if (botCheck) {
    await storage.set('session', 'browserNotice', {
      tabId,
      title: 'Anemo stopped at a check for people',
      body: `${new URL(page.url).hostname} wants to know whether a person is there. Solve it in the tab in the “Anemo” group, then tell Anemo to continue.`,
      at: Date.now(),
    })
  }
  let screenshot: string | null = null
  if (withScreenshot) {
    // A tab in the background may not be drawn: then there's no screenshot this time.
    screenshot = await Promise.race([
      send<{ data: string }>(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 70 }).then((r) => r.data),
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ]).catch(() => null)
  }
  return {
    url: page.url,
    title: page.title,
    text: page.text,
    textCut: page.cut,
    scroll: page.scroll,
    elements: list.map(elementLine),
    moreElements: more,
    links: list.map((e) => ({ ref: e.ref, follow: e.follow })),
    botCheck,
    screenshot,
  }
}

/* ── acting ── */

async function element(tabId: number, ref: number | undefined): Promise<ElementInfo & { node: number }> {
  const found = ref !== undefined ? elements.get(tabId)?.get(ref) : undefined
  if (!found) throw new Refused(`There is no element [${ref}] on the page as last read. Read the page again (browser_read) and use its numbers.`)
  return found
}

async function center(tabId: number, node: number): Promise<{ x: number; y: number }> {
  await send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: node }).catch(() => undefined)
  const { quads } = await send<{ quads: number[][] }>(tabId, 'DOM.getContentQuads', { backendNodeId: node })
  const q = quads?.[0]
  if (!q) throw new Refused('That element isn’t visible on the page, so it can’t be clicked.')
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 }
}

async function click(tabId: number, node: number): Promise<void> {
  const { x, y } = await center(tabId, node)
  const waiting = settle(tabId)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send(tabId, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 })
  }
  await waiting
}

const SELECT_ALL = `function () {
  if (this instanceof HTMLSelectElement) return 'select'
  this.focus()
  if (typeof this.select === 'function') this.select()
  else { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r) }
  return 'text'
}`

const CHOOSE_OPTION = `function (wanted) {
  const options = [...this.options]
  const hit = options.find((o) => o.text.trim() === wanted) || options.find((o) => o.value === wanted) || options.find((o) => o.text.trim().toLowerCase().includes(wanted.toLowerCase()))
  if (!hit) return 'none'
  this.value = hit.value
  this.dispatchEvent(new Event('input', { bubbles: true }))
  this.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
}`

async function type(tabId: number, target: ElementInfo & { node: number }, text: string, enter: boolean): Promise<void> {
  if (target.password) throw new Refused('That is a password field. Browser control never types into password fields: ask the user to fill it in.')
  const { object } = await send<{ object: { objectId: string } }>(tabId, 'DOM.resolveNode', { backendNodeId: target.node })
  const kind = await send<{ result: { value: string } }>(tabId, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: SELECT_ALL, returnByValue: true })
  if (kind.result.value === 'select') {
    const chosen = await send<{ result: { value: string } }>(tabId, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: CHOOSE_OPTION, arguments: [{ value: text }], returnByValue: true })
    if (chosen.result.value !== 'ok') throw new Refused(`The dropdown has no option “${text}”.`)
  } else {
    await send(tabId, 'Input.insertText', { text })
  }
  if (enter) {
    const waiting = settle(tabId)
    for (const t of ['rawKeyDown', 'char', 'keyUp']) {
      await send(tabId, 'Input.dispatchKeyEvent', { type: t, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(t === 'char' ? { text: '\r' } : {}) })
    }
    await waiting
  }
}

async function scroll(tabId: number, how: string | undefined): Promise<void> {
  const expression = how === 'down' ? 'scrollBy(0, innerHeight * 0.85)' : how === 'up' ? 'scrollBy(0, -innerHeight * 0.85)' : how === 'top' ? 'scrollTo(0, 0)' : ''
  if (!expression) return
  await send(tabId, 'Runtime.evaluate', { expression })
  await new Promise((r) => setTimeout(r, 300))
}

async function blocked(url: string): Promise<string | null> {
  const prefs = withDefaults(await storage.get('local', 'preferences'))
  const connection = await storage.get('local', 'connection')
  return blockedReason(url, prefs.browserBlocklist, connection?.serverUrl ?? null)
}

async function run(cmd: Command): Promise<Record<string, unknown>> {
  let tab = await tabOf(cmd.session)
  if (cmd.action === 'open') {
    const url = String(cmd.url ?? '')
    const why = await blocked(url)
    if (why) throw new Refused(`${why} Don’t try it another way.`)
    tab ??= await newTab(cmd.session)
    await attach(tab.id!)
    await navigate(tab.id!, url)
  } else {
    if (!tab) throw new Refused('No page of this chat is open in the user’s Chrome (it was closed, or taken out of the “Anemo” group). Open one with browser_open first.')
    await attach(tab.id!)
    if (cmd.action === 'read') await scroll(tab.id!, cmd.scroll)
    else if (cmd.action === 'click') {
      const target = await element(tab.id!, cmd.ref)
      if (target.follow && target.href) {
        // Following a link is only going to its address (free): no script runs on the click.
        const why = await blocked(target.href)
        if (why) throw new Refused(`${why} Don’t try it another way.`)
        await navigate(tab.id!, target.href)
      } else {
        // Approved by the user in Anemo (every such click is asked about first).
        await send(tab.id!, 'Page.setDownloadBehavior', { behavior: 'default' }).catch(() => undefined)
        try {
          await click(tab.id!, target.node)
        } finally {
          await send(tab.id!, 'Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => undefined)
        }
      }
    } else if (cmd.action === 'type') {
      await type(tab.id!, await element(tab.id!, cmd.ref), String(cmd.text ?? ''), Boolean(cmd.press_enter))
    } else if (cmd.action !== 'screenshot') {
      throw new Refused(`Unknown browser action “${cmd.action}”.`)
    }
  }
  // Where it ended up: a blocked site (a redirect, a link) is left at once.
  const now = await chrome.tabs.get(tab.id!)
  const why = now.url && now.url !== 'about:blank' ? await blocked(now.url) : null
  if (why) {
    await navigate(tab.id!, 'about:blank').catch(() => undefined)
    throw new Refused(`The page went to a site browser control doesn’t use: ${why}`)
  }
  return snapshot(tab.id!, true)
}

/** One command from Anemo: run it and answer. Only called for messages from the socket. */
export async function handleCommand(cmd: Command, reply: Reply): Promise<void> {
  const active = await storage.get('session', 'browserActive')
  if (!active?.on) {
    reply({ type: 'browser.result', id: cmd.id, ok: false, error: 'Browser control is switched off in the extension.' })
    return
  }
  await storage.set('session', 'browserActive', { ...active, lastCommandAt: Date.now() })
  try {
    const state = await run(cmd)
    reply({ type: 'browser.result', id: cmd.id, ok: true, state })
  } catch (err) {
    const message = err instanceof Refused ? err.message : `Your Chrome couldn’t do that: ${err instanceof Error ? err.message : String(err)}`
    log.debug('browser command failed', { action: cmd.action })
    reply({ type: 'browser.result', id: cmd.id, ok: false, error: message.slice(0, 500) })
  }
}

/** Chrome's debugging bar: "Cancel" there is a kill switch too. */
export function listenForDetach(): void {
  chrome.debugger?.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return
    attached.delete(source.tabId)
    elements.delete(source.tabId)
    if (reason === 'canceled_by_user') void turnOff()
  })
}
