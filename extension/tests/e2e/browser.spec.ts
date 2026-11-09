import type { Page, Worker } from '@playwright/test'
import { expect, test } from './fixtures'
import { send } from './mockAnemo'
import { addEvents, type MockEvents } from './mockEvents'

let events: MockEvents
let worker: Worker
let site: string

const FORM = `<!doctype html><html><head><title>Shop</title></head><body>
<h1>Shop</h1>
<a href="/form?page=2">Next page</a>
<a href="/files/report.zip">Download report</a>
<button onclick="document.getElementById('out').textContent = 'Ordered!'">Buy now</button>
<label>Search <input id="q" type="text"></label>
<label>Password <input id="pw" type="password"></label>
<label>Size <select id="size"><option>Small</option><option>Large</option></select></label>
<p id="out">Nothing yet</p>
</body></html>`

const CHECK = `<!doctype html><html><head><title>Just a moment</title></head><body><h1>Verify you are human</h1><iframe src="about:blank"></iframe></body></html>`

async function inWorker<T>(fn: () => Promise<T>): Promise<T> {
  return worker.evaluate(fn)
}

async function groupedTabs(): Promise<string[]> {
  return worker.evaluate(async () => {
    const [group] = await chrome.tabGroups.query({ title: 'Anemo' })
    if (!group) return []
    return (await chrome.tabs.query({ groupId: group.id })).map((t) => t.url ?? '')
  })
}

async function turnOn(panel: Page) {
  await inWorker(async () => {
    const stored = ((await chrome.storage.local.get('preferences')).preferences ?? {}) as { features?: Record<string, boolean> }
    await chrome.storage.local.set({ preferences: { ...stored, features: { ...(stored.features ?? {}), browserControl: true } } })
  })
  await panel.getByRole('button', { name: 'Settings' }).click()
  await panel.getByRole('switch', { name: 'Let Anemo use this browser now' }).click()
  await expect(panel.getByText('Anemo can use this browser (its “Anemo” tab group)')).toBeVisible()
  await expect.poll(() => events.offers.at(-1)).toBe(true)
}

test.beforeEach(async ({ panel, anemo, context }) => {
  events = addEvents(anemo)
  anemo.routes.set('GET /form', (_r, _b, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(FORM)
  })
  anemo.routes.set('GET /check', (_r, _b, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(CHECK)
  })
  anemo.routes.set('GET /files/report.zip', (_r, _b, res) => send(res, 200, {}))
  site = anemo.url.replace('127.0.0.1', 'localhost')
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  await panel.getByLabel('Anemo address').fill(anemo.url)
  await panel.getByLabel('API token').fill('anemo_good-token')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('What can I help with?')).toBeVisible()
  await expect.poll(() => events.sockets.size, { timeout: 10_000 }).toBe(1)
})

test('off until switched on: commands are refused and nothing is offered', async ({ panel }) => {
  const answer = await events.command({ action: 'open', url: `${site}/form` })
  expect(answer).toMatchObject({ ok: false, error: 'Browser control is switched off in the extension.' })
  expect(events.offers.every((o) => o === false)).toBe(true)
  expect(await groupedTabs()).toEqual([])
  await panel.getByRole('button', { name: 'Settings' }).click()
  await expect(panel.getByRole('switch', { name: 'Let Anemo use this browser now' })).toHaveCount(0) // the feature isn't allowed yet
})

test('the agent opens a page in its own tab group, reads it, follows links, types and clicks', async ({ panel, context }) => {
  const mine = await context.newPage() // one of your own tabs
  await mine.goto(`${site}/form`)
  await turnOn(panel)

  const opened = await events.command({ action: 'open', url: `${site}/form` })
  expect(opened.ok).toBe(true)
  const state = opened.state!
  expect(state.title).toBe('Shop')
  expect(state.text).toContain('Nothing yet')
  const elements = state.elements as string[]
  expect(elements).toEqual(expect.arrayContaining([expect.stringMatching(/^\[\d+\] link "Next page" → http:\/\/localhost:\d+\/form\?page=2$/), expect.stringMatching(/button "Buy now"/), expect.stringMatching(/password: never typed into/)]))
  const ref = (pattern: RegExp) => Number(/^\[(\d+)\]/.exec(elements.find((e) => pattern.test(e))!)![1])
  // Following a plain link is marked as free; a download link and a button are not.
  const links = state.links as { ref: number; follow: boolean }[]
  expect(links.find((l) => l.ref === ref(/Next page/))!.follow).toBe(true)
  expect(links.find((l) => l.ref === ref(/Download report/))!.follow).toBe(false)
  expect(links.find((l) => l.ref === ref(/Buy now/))!.follow).toBe(false)
  // Only the agent's tab is in the group; yours stays out.
  expect(await groupedTabs()).toEqual([`${site}/form`])

  const typed = await events.command({ action: 'type', ref: ref(/textbox "Search"/), text: 'blue shoes' })
  expect(typed.ok).toBe(true)
  expect(typed.state!.elements as string[]).toEqual(expect.arrayContaining([expect.stringMatching(/textbox "Search" \(now: "blue shoes"\)/)]))
  const chosen = await events.command({ action: 'type', ref: ref(/combobox "Size"/), text: 'Large' })
  expect(chosen.ok).toBe(true)
  const password = await events.command({ action: 'type', ref: ref(/password/), text: 'hunter2' })
  expect(password).toMatchObject({ ok: false })
  expect(password.error).toContain('never types into password fields')
  const bought = await events.command({ action: 'click', ref: ref(/Buy now/) })
  expect(bought.state!.text).toContain('Ordered!')

  const next = await events.command({ action: 'click', ref: ref(/Next page/) })
  expect(next.state!.url).toBe(`${site}/form?page=2`)
  // Your own tab was never touched.
  expect(await mine.locator('#out').textContent()).toBe('Nothing yet')
  expect(await mine.locator('#q').inputValue()).toBe('')

  // Stop: refused from now on, the debugger lets go, Anemo is told.
  await panel.getByRole('button', { name: 'Stop' }).click()
  await expect(panel.getByText('Anemo can use this browser (its “Anemo” tab group)')).toHaveCount(0)
  await expect.poll(() => events.offers.at(-1)).toBe(false)
  expect((await events.command({ action: 'read' })).ok).toBe(false)
  // The extension's own debugger connection is gone (Chrome's bar with it).
  const stillAttached = await inWorker(async () => {
    const tabId = ((await chrome.storage.session.get('browserTabs')).browserTabs as Record<string, number>)['conv-1']
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' })
      return true
    } catch {
      return false
    }
  })
  expect(stillAttached).toBe(false)
})

test('never Anemo itself, Chrome’s pages, banks or the blocklist; stops at a person check', async ({ panel, anemo }) => {
  await turnOn(panel)
  for (const url of [`${anemo.url}/form`, 'https://www.paypal.com/', 'https://mybank.example/', 'https://www.gov.uk/x', 'chrome://settings']) {
    const answer = await events.command({ action: 'open', url })
    expect(answer.ok, url).toBe(false)
  }
  expect(await groupedTabs()).toEqual([])
  // Added to the blocklist in Settings.
  await panel.getByLabel('Site to never use').fill('localhost')
  await panel.getByRole('button', { name: 'Add to the blocklist' }).click()
  const blocked = await events.command({ action: 'open', url: `${site}/form` })
  expect(blocked.error).toContain('localhost is on your browser-control blocklist')
  await panel.getByRole('button', { name: 'Remove localhost from the blocklist' }).click()

  const check = await events.command({ action: 'open', url: `${site}/check` })
  expect(check.state!.botCheck).toBe(true)
  await expect(panel.getByText('Anemo stopped at a check for people')).toBeVisible()
})

test('goes off by itself after 10 minutes without a command', async ({ panel }) => {
  await turnOn(panel)
  await inWorker(async () => {
    const active = (await chrome.storage.session.get('browserActive')).browserActive as Record<string, unknown>
    await chrome.storage.session.set({ browserActive: { ...active, lastCommandAt: Date.now() - 11 * 60_000 } })
    await (globalThis as unknown as { __anemoTest: { checkIdle: () => Promise<void> } }).__anemoTest.checkIdle()
  })
  await expect(panel.getByText('Anemo can use this browser (its “Anemo” tab group)')).toHaveCount(0)
  await expect.poll(() => events.offers.at(-1)).toBe(false)
})
