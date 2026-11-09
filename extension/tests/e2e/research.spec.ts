import type { Page, Worker } from '@playwright/test'
import { expect, test } from './fixtures'
import { addChat } from './mockChat'
import { addEvents } from './mockEvents'
import { addResearch } from './mockResearch'

let research: ReturnType<typeof addResearch>
let article: Page
let worker: Worker

/** A right-click menu entry or a shortcut, as the worker would handle it. */
async function trigger(id: string, selection = false) {
  await worker.evaluate(
    async ({ id, selection }) => {
      const [tab] = await chrome.tabs.query({ active: true, windowType: 'normal' })
      await (globalThis as unknown as { __anemoTest: { handle: (id: string, tab: unknown, selection: boolean) => Promise<void> } }).__anemoTest.handle(id, tab, selection)
    },
    { id, selection },
  )
}

const badge = () => worker.evaluate(() => chrome.action.getBadgeText({}))

async function select(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const range = document.createRange()
    range.selectNodeContents(document.querySelector(sel)!)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  }, selector)
}

async function start(panel: Page, topic: string) {
  await panel.getByRole('button', { name: 'Research' }).click()
  await panel.getByLabel('Topic or question').fill(topic)
  await panel.getByRole('button', { name: 'Start' }).click()
  await expect(panel.getByRole('heading', { name: topic })).toBeVisible()
}

test.beforeEach(async ({ panel, anemo, context }) => {
  const chat = addChat(anemo)
  const events = addEvents(anemo)
  research = addResearch(anemo, events, chat)
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  await panel.getByLabel('Anemo address').fill(anemo.url)
  await panel.getByLabel('API token').fill('anemo_good-token')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('What can I help with?')).toBeVisible()
  await expect.poll(() => events.sockets.size, { timeout: 10_000 }).toBe(1)
  article = await context.newPage()
  await article.goto(`${anemo.url}/article`)
  await article.bringToFront()
})

test('start a session, add the page and a selection, then annotate, star, reorder and remove', async ({ panel }) => {
  await start(panel, 'How do plants store energy?')
  // The indicator in the header and the badge dot.
  await panel.getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(panel.getByRole('button', { name: /Research: How do plants store energy\?/ })).toBeVisible()
  await expect.poll(badge).toBe('●')
  await panel.getByRole('button', { name: /Research: How do plants/ }).click()

  await panel.getByLabel('Note (optional)').fill('The overview')
  await panel.getByRole('button', { name: 'Add this page' }).click()
  await expect(panel.getByRole('listitem', { name: 'Photosynthesis explained' })).toContainText('The overview')
  await select(article, 'article p:nth-of-type(3)')
  await panel.getByRole('button', { name: 'Add the selection' }).click()
  await expect(panel.getByRole('list', { name: 'Sources' }).getByRole('listitem')).toHaveCount(2)
  const [page, selection] = research.sessions[0].sources
  expect(page).toMatchObject({ kind: 'page', title: 'Photosynthesis explained', note: 'The overview' })
  expect(page.content).toContain('plants turn **light**')
  expect(selection).toMatchObject({ kind: 'selection', note: '' })
  expect(selection.content).toBe('Paragraph 2: plants turn light into chemical energy stored in glucose, releasing oxygen.')

  // Annotate the second, star it, move it up, then remove the other one.
  const items = panel.getByRole('list', { name: 'Sources' }).getByRole('listitem')
  await items.nth(1).getByRole('button', { name: 'Add a note' }).click()
  await panel.getByLabel('Note on S2').fill('The key claim')
  await panel.getByRole('button', { name: 'Save note' }).click()
  await expect(items.nth(1)).toContainText('The key claim')
  await items.nth(1).getByRole('button', { name: 'Mark as key source' }).click()
  await expect(items.nth(1).getByRole('button', { name: 'Key source' })).toHaveAttribute('aria-pressed', 'true')
  await panel.getByRole('button', { name: 'Move S2 up' }).click()
  await expect(items.first()).toContainText('The key claim')
  expect(research.sessions[0].sources.map((s) => s.kind)).toEqual(['selection', 'page'])
  await panel.getByRole('button', { name: 'Remove S2' }).click()
  await panel.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(items).toHaveCount(1)
  expect(research.sessions[0].sources).toHaveLength(1)
  expect(research.sessions[0].sources[0]).toMatchObject({ key: true, note: 'The key claim' })
})

test('the menu and the shortcut add to the active session, and say so when there is none', async ({ panel }) => {
  await trigger('anemo-add-to-research')
  await expect(panel.getByText('No research session')).toBeVisible()
  expect(research.sessions).toHaveLength(0)

  await start(panel, 'Glucose')
  await article.bringToFront()
  await trigger('anemo-add-to-research')
  await expect(panel.getByRole('listitem', { name: 'Photosynthesis explained' })).toBeVisible()
  await expect(panel.getByText('Added “Photosynthesis explained”')).toBeVisible()
  await panel.getByRole('button', { name: 'Add a note', exact: true }).first().click()
  await expect(panel.getByLabel('Note on S1')).toBeFocused()

  // Alt+Shift+R: the selection when there is one.
  await select(article, 'article p:nth-of-type(3)')
  await trigger('add-to-research')
  await expect.poll(() => research.sessions[0].sources.length).toBe(2)
  expect(research.sessions[0].sources[1].kind).toBe('selection')
})

test('pause and resume, chat about the sources, end with a write-up and reopen', async ({ panel }) => {
  await start(panel, 'Leaves')
  await panel.getByRole('button', { name: 'Add this page' }).click()
  await expect(panel.getByRole('list', { name: 'Sources' }).getByRole('listitem')).toHaveCount(1)

  await panel.getByRole('button', { name: 'Pause' }).click()
  await expect(panel.getByText('Resume the session to add sources.')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Add this page' })).toHaveCount(0)
  await expect.poll(badge).toBe('')
  await panel.getByRole('button', { name: 'Resume' }).click()
  await expect(panel.getByRole('button', { name: 'Add this page' })).toBeVisible()

  await panel.getByRole('button', { name: 'Chat about the sources' }).click()
  await expect(panel.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(panel.getByText('Research: Leaves').first()).toBeVisible()

  await panel.getByRole('button', { name: /Research: Leaves/ }).click()
  await panel.getByRole('button', { name: 'End & write up' }).click()
  await panel.getByRole('radio', { name: /Essay outline/ }).check()
  await panel.getByRole('button', { name: 'End & write up' }).last().click()
  await expect(panel.getByText(/Writing it up/)).toBeVisible()
  await expect(panel.getByRole('link', { name: 'Open the write-up' })).toHaveAttribute('href', /\/documents\/doc-writeup$/)
  expect(research.ended).toEqual([{ id: research.sessions[0].id, format: 'outline' }])
  await expect.poll(badge).toBe('')

  // The list shows it as ended; it can be reopened.
  await panel.getByRole('button', { name: 'All sessions' }).click()
  await expect(panel.getByRole('list', { name: 'Research sessions' })).toContainText('Ended')
  await panel.getByRole('button', { name: /Leaves/ }).click()
  await panel.getByRole('button', { name: 'Reopen' }).click()
  await expect(panel.getByRole('button', { name: 'Add this page' })).toBeVisible()
})

test('only one session is active at a time', async ({ panel }) => {
  await start(panel, 'First')
  await panel.getByRole('button', { name: 'All sessions' }).click()
  await expect(panel.getByLabel('Topic or question')).toBeDisabled()
  await expect(panel.getByText('Pause or end “First” to start another')).toBeVisible()
})
