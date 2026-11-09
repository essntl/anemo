import type { Page, Worker } from '@playwright/test'
import { expect, test } from './fixtures'
import { addEvents } from './mockEvents'
import { addFocus, type TimerWire } from './mockFocus'

let focus: ReturnType<typeof addFocus>
let worker: Worker
const MIN = 60_000

const badge = () => worker.evaluate(() => chrome.action.getBadgeText({}))
const rules = () => worker.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.condition.requestDomains?.[0]))
const notifications = () => worker.evaluate(() => new Promise<string[]>((r) => chrome.notifications.getAll((all) => r(Object.keys(all)))))

function running(startedMsAgo: number, extra: Partial<TimerWire> = {}): TimerWire {
  const at = Date.now() - startedMsAgo
  return { phase: 'focus', status: 'running', phase_started_at: at, started_at: at, paused_at: null, accumulated: 0, duration: 25 * MIN, round: 0, task_id: null, session_id: 'elsewhere-1', ...extra }
}

test.beforeEach(async ({ panel, anemo, context }) => {
  const events = addEvents(anemo)
  focus = addFocus(anemo, events)
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  await context.route('https://distraction.test/**', (route) => route.fulfill({ body: '<title>Distraction</title><h1>Very distracting</h1>', contentType: 'text/html' }))
  await panel.getByLabel('Anemo address').fill(anemo.url)
  await panel.getByLabel('API token').fill('anemo_good-token')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('What can I help with?')).toBeVisible()
  await expect.poll(() => events.sockets.size, { timeout: 10_000 }).toBe(1)
  await panel.getByRole('button', { name: 'Focus' }).click()
})

async function blockDistraction(panel: Page) {
  await panel.getByLabel('Site to block').fill('https://www.distraction.test/feed')
  await panel.getByRole('button', { name: 'Add site' }).click()
  await expect(panel.getByRole('list', { name: 'Blocked sites' })).toContainText('distraction.test')
  await panel.getByRole('switch', { name: 'Block distractions during focus' }).click()
  await expect(panel.getByRole('switch', { name: 'Block distractions during focus' })).toBeChecked()
}

test('start focus for a task: the shared timer runs, the badge counts, the site is blocked', async ({ panel, context }) => {
  await blockDistraction(panel)
  await panel.getByLabel('Task (optional)').selectOption({ label: 'Write the introduction' })
  await panel.getByRole('button', { name: 'Start focus' }).click()
  await expect(panel.getByTestId('focus-timer')).toContainText(/2[45]:\d\d/)
  expect(focus.timer.state).toMatchObject({ phase: 'focus', status: 'running', task_id: 'task-1' })
  expect(focus.puts[0]).toMatchObject({ base_version: 0, source: 'extension' })
  await expect.poll(badge).toMatch(/^2[45]m$/)
  await expect.poll(rules).toEqual(['distraction.test'])

  const tab = await context.newPage()
  await tab.goto('https://distraction.test/watch?v=1').catch(() => undefined)
  await expect(tab).toHaveURL(/pages\/blocked\.html#https:\/\/distraction\.test\/watch\?v=1$/)
  await expect(tab.getByRole('heading')).toHaveText('distraction.test is blocked while you focus')
  await expect(tab.getByTestId('focus-left')).toHaveText(/2[45]:\d\d/)
  await expect(tab.getByText('You’re working on “Write the introduction”.')).toBeVisible()

  // Pausing frees the site (blocking is for a running focus phase only).
  await panel.getByRole('button', { name: 'Pause' }).click()
  await expect.poll(() => focus.timer.state?.status).toBe('paused')
  await expect.poll(rules).toEqual([])
  await expect.poll(badge).toBe('')
  await expect(tab.getByRole('heading')).toHaveText('Focus is over')
  await tab.getByRole('link', { name: 'Go to distraction.test' }).click()
  await expect(tab.getByRole('heading')).toHaveText('Very distracting')
})

test('a phase that ends is finished by the extension: session, notice, rules off', async ({ panel, context }) => {
  await blockDistraction(panel)
  // Started in Anemo; ends in two seconds. No Anemo tab is open to finish it.
  focus.changeElsewhere(running(25 * MIN - 2000))
  await expect(panel.getByTestId('focus-timer')).toContainText(/0:0[0-2]/)
  await expect.poll(rules).toEqual(['distraction.test'])
  const tab = await context.newPage()
  await tab.goto('https://distraction.test/').catch(() => undefined)
  await expect(tab).toHaveURL(/blocked\.html/)

  await expect.poll(() => focus.timer.state?.phase, { timeout: 15_000 }).toBe('short_break')
  expect(focus.puts.at(-1)).toMatchObject({ source: 'extension' })
  await expect.poll(() => focus.sessions).toEqual([expect.objectContaining({ client_id: 'elsewhere-1', minutes: 25, completed: true })])
  await expect.poll(() => focus.phaseEnded).toEqual([{ title: 'Break time', body: 'Session complete. Enjoy 5 minutes off.' }])
  await expect.poll(rules).toEqual([])
  await expect.poll(notifications).toContain('focus:elsewhere-1')
  await expect(tab.getByRole('heading')).toHaveText('Focus is over')
  await expect(panel.getByTestId('focus-timer')).toContainText('Short break')
})

test('a change made elsewhere first wins; the panel’s button then acts on it', async ({ panel }) => {
  await panel.getByRole('button', { name: 'Start focus' }).click()
  await expect.poll(() => focus.timer.version).toBe(1)
  // Another device paused it, and the event hasn't arrived yet: the next click is on version 1.
  focus.timer.state = { ...focus.timer.state!, status: 'paused', started_at: null, paused_at: Date.now(), accumulated: 3 * MIN }
  focus.timer.version = 5
  await panel.getByRole('button', { name: 'Stop' }).click()
  await expect.poll(() => focus.timer.state?.status).toBe('idle')
  expect(focus.puts.slice(1).map((p) => p.base_version)).toEqual([1, 5])
  // Three focused minutes before the stop are kept.
  await expect.poll(() => focus.sessions).toEqual([expect.objectContaining({ minutes: 3, completed: false })])
})

test('a site needs blocking switched on, and nothing is blocked outside focus', async ({ panel, context }) => {
  await panel.getByLabel('Site to block').fill('distraction.test')
  await panel.getByRole('button', { name: 'Add site' }).click()
  await expect(panel.getByText('Blocking is off: switch it on to block these during focus.')).toBeVisible()
  await panel.getByRole('button', { name: 'Start focus' }).click()
  await expect.poll(() => focus.timer.state?.status).toBe('running')
  await expect.poll(rules).toEqual([])
  const tab = await context.newPage()
  await tab.goto('https://distraction.test/')
  await expect(tab.getByRole('heading')).toHaveText('Very distracting')
  await panel.getByLabel('Site to block').fill('not a site')
  await panel.getByRole('button', { name: 'Add site' }).click()
  await expect(panel.getByText('That isn’t a site address (try “youtube.com”).')).toBeVisible()
})
