/**
 * Against a real Anemo, when one is given (skipped otherwise):
 *   ANEMO_E2E_URL=http://127.0.0.1:8099 ANEMO_E2E_TOKEN=anemo_… npm run e2e
 * The URL must be on 127.0.0.1 (the test build may reach only that without a prompt).
 * Use a throwaway install: the tests create chats in it.
 */
import { choose, expect, test } from './fixtures'

const url = process.env.ANEMO_E2E_URL
const token = process.env.ANEMO_E2E_TOKEN

test.skip(!url || !token, 'set ANEMO_E2E_URL and ANEMO_E2E_TOKEN to run against a real Anemo')

test('connects to a real Anemo with a token (Bearer auth and the Origin check)', async ({ panel }) => {
  await panel.getByLabel('Anemo address').fill(url!)
  await panel.getByLabel('API token').fill(token!)
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('What can I help with?')).toBeVisible()
})

test('a wrong token gets Anemo’s 401 and the right message', async ({ panel }) => {
  await panel.getByLabel('Anemo address').fill(url!)
  await panel.getByLabel('API token').fill('anemo_definitely-not-valid')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('The token doesn’t work')).toBeVisible()
})

/**
 * Chat against a real Anemo with its scripted fake provider (ENABLE_FAKE_PROVIDER=true and
 * e2e/scripts/seed-fake.mjs: models "Echo", "Slow echo", "Demo agent"; Echo is the default).
 */
test.describe('chat (real Anemo with the fake provider)', () => {
  test.beforeEach(async ({ panel }) => {
    await panel.getByLabel('Anemo address').fill(url!)
    await panel.getByLabel('API token').fill(token!)
    await panel.getByRole('button', { name: 'Connect' }).click()
    await expect(panel.getByText('What can I help with?')).toBeVisible()
  })

  test('streams an answer, and the chat is in the list', async ({ panel }) => {
    await panel.getByLabel('Message').fill('hello from the panel')
    await panel.getByLabel('Message').press('Enter')
    await expect(panel.getByTestId('assistant-message').last()).toContainText('You said: hello from the panel')
    await panel.getByRole('button', { name: 'All chats' }).click()
    await expect(panel.getByRole('region', { name: 'Chats' }).getByRole('listitem').first()).toBeVisible()
  })

  test('stop ends a slow answer', async ({ panel }) => {
    await choose(panel, 'Model', 'Slow echo')
    await panel.getByLabel('Message').fill('one two three four five six seven eight nine ten eleven twelve')
    await panel.getByRole('button', { name: 'Send' }).click()
    await expect(panel.getByRole('button', { name: 'Stop' })).toBeVisible()
    await panel.getByRole('button', { name: 'Stop' }).click()
    await expect(panel.getByText('Stopped.')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible()
  })

  test('the agent asks a question; answering it lets the run finish', async ({ panel }) => {
    await panel.getByRole('radio', { name: 'agent' }).click()
    await choose(panel, 'Model', 'Demo agent')
    await panel.getByLabel('Message').fill('please ask me which folder to use')
    await panel.getByRole('button', { name: 'Send' }).click()
    const card = panel.getByTestId('approval-card')
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.getByPlaceholder('Your answer').fill('the notes folder')
    await card.getByRole('button', { name: 'Answer' }).click()
    await expect(card).toBeHidden({ timeout: 20_000 })
    await expect(panel.getByTestId('assistant-message').last()).toContainText('notes folder', { timeout: 20_000 })
  })
})

test('a reminder in Anemo becomes a Chrome notification through the event stream', async ({ panel, context }) => {
  test.setTimeout(120_000)
  await panel.getByLabel('Anemo address').fill(url!)
  await panel.getByLabel('API token').fill(token!)
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('What can I help with?')).toBeVisible()
  const worker = context.serviceWorkers()[0]
  await expect
    .poll(() => worker.evaluate(async () => ((await chrome.storage.session.get('stream')).stream as { state?: string } | undefined)?.state), { timeout: 15_000 })
    .toBe('connected')

  // A task due this minute, reminder at the due time (Anemo's time zone is UTC here).
  const now = new Date()
  const res = await fetch(`${url}/api/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'chrome-extension://jpmimgldkledmklijfmfnbaaimmfjaaf' },
    body: JSON.stringify({
      title: `Read chapter ${now.getTime()}`,
      due_date: now.toISOString().slice(0, 10),
      due_time: now.toISOString().slice(11, 16),
      remind_minutes: 0,
    }),
  })
  expect(res.status).toBe(201)
  // Anemo's scheduler fires it within ~30 s; the worker turns it into a notification.
  await expect
    .poll(() => worker.evaluate(async () => Object.keys(await chrome.notifications.getAll())), { timeout: 90_000, intervals: [2000] })
    .toEqual(expect.arrayContaining([expect.stringMatching(/^n:/)]))
})

test('a page attached in the panel reaches the model wrapped as untrusted data', async ({ panel, context }) => {
  const { createServer } = await import('node:http')
  const { ARTICLE } = await import('./mockAnemo')
  const site = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(ARTICLE)
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
  const port = (site.address() as import('node:net').AddressInfo).port
  try {
    await panel.getByLabel('Anemo address').fill(url!)
    await panel.getByLabel('API token').fill(token!)
    await panel.getByRole('button', { name: 'Connect' }).click()
    await expect(panel.getByText('What can I help with?')).toBeVisible()
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${port}/article`)
    await page.bringToFront()
    await panel.getByRole('button', { name: 'Include this page' }).click()
    await expect(panel.getByTestId('page-chip')).toContainText('Photosynthesis explained')
    await panel.getByLabel('Message').fill('what is this about')
    await panel.getByLabel('Message').press('Enter')
    // The fake "echo" model repeats what it was sent: the page, wrapped by Anemo.
    const answer = panel.getByTestId('assistant-message').last()
    await expect(answer).toContainText('untrusted_page_content', { timeout: 20_000 })
    await expect(answer).toContainText('not instructions')
    await expect(answer).toContainText('plants turn')
    await expect(panel.getByTestId('user-message').last()).toContainText('Photosynthesis explained')
  } finally {
    site.close()
  }
})

test('saving a page goes through Anemo’s worker and lands in a document', async ({ panel, context }) => {
  test.setTimeout(90_000)
  const { createServer } = await import('node:http')
  const { ARTICLE } = await import('./mockAnemo')
  const site = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(ARTICLE)
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
  const port = (site.address() as import('node:net').AddressInfo).port
  try {
    await panel.getByLabel('Anemo address').fill(url!)
    await panel.getByLabel('API token').fill(token!)
    await panel.getByRole('button', { name: 'Connect' }).click()
    await expect(panel.getByText('What can I help with?')).toBeVisible()
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${port}/article`)
    await page.bringToFront()
    await panel.getByRole('button', { name: 'Capture' }).click()
    await panel.getByRole('button', { name: /Save page/ }).click()
    await panel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(panel.getByTestId('capture-done')).toContainText('Saved to', { timeout: 60_000 })
    const href = await panel.getByRole('link', { name: 'View' }).getAttribute('href')
    const id = href!.split('/').pop()!
    const doc = await (await fetch(`${url}/api/documents/${id}`, { headers: { Authorization: `Bearer ${token}` } })).json()
    expect(doc.path).toMatch(/^documents\/Web clips\/photosynthesis-explained( \(\d+\))?\.md$/)
    expect(doc.content).toMatch(/^# Photosynthesis explained\n\nSource: \[127\.0\.0\.1:\d+\]\(http:\/\/127\.0\.0\.1:\d+\/article\) · Saved /)
    // The fake "echo" model "formats" by repeating what it got: the content, fenced as untrusted.
    expect(doc.content).toContain('untrusted_web_content')
    expect(doc.content).toContain('plants turn **light**')
  } finally {
    site.close()
  }
})

test('Explain on a page asks Anemo’s inline endpoint (fenced, nothing personal)', async ({ panel, context }) => {
  const { createServer } = await import('node:http')
  const { ARTICLE } = await import('./mockAnemo')
  const site = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(ARTICLE)
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
  const port = (site.address() as import('node:net').AddressInfo).port
  try {
    await panel.getByLabel('Anemo address').fill(url!)
    await panel.getByLabel('API token').fill(token!)
    await panel.getByRole('button', { name: 'Connect' }).click()
    await expect(panel.getByText('What can I help with?')).toBeVisible()
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${port}/article`)
    await page.bringToFront()
    await page.evaluate(() => {
      const range = document.createRange()
      range.selectNodeContents(document.querySelector('article p strong')!)
      getSelection()!.removeAllRanges()
      getSelection()!.addRange(range)
    })
    const worker = context.serviceWorkers()[0]
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, windowType: 'normal' })
      ;(globalThis as unknown as { __anemoTest: { onInlineClick: (id: string, info: unknown, tab: unknown) => void } }).__anemoTest.onInlineClick(
        'anemo-explain', { menuItemId: 'anemo-explain', frameId: 0, selectionText: 'light', pageUrl: tab.url, frameUrl: tab.url }, tab)
    })
    // The fake "echo" model repeats what Anemo sent it (rendered as Markdown, the fence
    // tags dropped by the sanitizer): the page, the paragraph, the selection; nothing else.
    const box = page.locator('anemo-companion .box')
    await expect(box).toContainText('You said: Page: Photosynthesis explained', { timeout: 20_000 })
    await expect(box).toContainText('Paragraph 0: plants turn light into chemical energy')
  } finally {
    site.close()
  }
})

test('a research session: sources reach the session chat as untrusted context, and the write-up is a document', async ({ panel, context }) => {
  test.setTimeout(120_000)
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  // One session is active at a time: pause one left by an earlier run.
  for (const s of await (await fetch(`${url}/api/research/sessions`, { headers: auth })).json()) {
    if (s.status === 'active') await fetch(`${url}/api/research/sessions/${s.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'paused' }) })
  }
  const { createServer } = await import('node:http')
  const { ARTICLE } = await import('./mockAnemo')
  const site = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(ARTICLE)
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
  const port = (site.address() as import('node:net').AddressInfo).port
  try {
    await panel.getByLabel('Anemo address').fill(url!)
    await panel.getByLabel('API token').fill(token!)
    await panel.getByRole('button', { name: 'Connect' }).click()
    await expect(panel.getByText('What can I help with?')).toBeVisible()
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${port}/article`)
    await page.bringToFront()
    const topic = `Energy in plants ${Date.now()}`
    await panel.getByRole('button', { name: 'Research' }).click()
    await panel.getByLabel('Topic or question').fill(topic)
    await panel.getByRole('button', { name: 'Start' }).click()
    await panel.getByLabel('Note (optional)').fill('The overview')
    await panel.getByRole('button', { name: 'Add this page' }).click()
    await expect(panel.getByRole('listitem', { name: 'Photosynthesis explained' })).toContainText('The overview')

    await panel.getByRole('button', { name: 'Chat about the sources' }).click()
    await panel.getByLabel('Message').fill('what do my sources say')
    await panel.getByLabel('Message').press('Enter')
    // The echo model repeats what it got: the sources, fenced and numbered.
    const answer = panel.getByTestId('assistant-message').last()
    await expect(answer).toContainText('untrusted_research_source', { timeout: 20_000 })
    await expect(answer).toContainText('plants turn')
    await expect(answer).toContainText('The overview')

    await panel.getByRole('button', { name: new RegExp(`Research: ${topic}`) }).click()
    await panel.getByRole('button', { name: 'End & write up' }).click()
    await panel.getByRole('button', { name: 'End & write up' }).last().click()
    const link = panel.getByRole('link', { name: 'Open the write-up' })
    await expect(link).toBeVisible({ timeout: 60_000 })
    const id = (await link.getAttribute('href'))!.split('/').pop()!
    const doc = await (await fetch(`${url}/api/documents/${id}`, { headers: auth })).json()
    expect(doc.path).toMatch(/^documents\/Research\/energy-in-plants-\d+( \(\d+\))?\.md$/)
    expect(doc.content).toMatch(new RegExp(`^# ${topic}\\n`))
    expect(doc.content).toMatch(/## Sources\n\n1\. \[Photosynthesis explained\]\(http:\/\/127\.0\.0\.1:\d+\/article\)/)
  } finally {
    site.close()
  }
})

test('focus: the panel and Anemo share one timer, and blocking follows it', async ({ panel, context }) => {
  test.setTimeout(60_000)
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const read = async () => (await (await fetch(`${url}/api/focus/timer`, { headers: auth })).json()) as { state: Record<string, unknown> | null; version: number }
  await context.route('https://distraction.test/**', (route) => route.fulfill({ body: '<h1>Very distracting</h1>', contentType: 'text/html' }))
  await panel.getByLabel('Anemo address').fill(url!)
  await panel.getByLabel('API token').fill(token!)
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('What can I help with?')).toBeVisible()
  await panel.getByRole('button', { name: 'Focus' }).click()
  // Whatever an earlier run left: stopped first.
  if ((await read()).state?.status !== 'idle' && (await read()).state) await panel.getByRole('button', { name: 'Stop' }).click()
  await panel.getByLabel('Site to block').fill('distraction.test')
  await panel.getByRole('button', { name: 'Add site' }).click()
  await panel.getByRole('switch', { name: 'Block distractions during focus' }).click()

  await panel.getByRole('button', { name: 'Start focus' }).click()
  await expect.poll(async () => (await read()).state?.status).toBe('running')
  const tab = await context.newPage()
  await tab.goto('https://distraction.test/').catch(() => undefined)
  await expect(tab).toHaveURL(/blocked\.html/)

  // Paused in Anemo (as a tab would): the panel and the blocking follow through the event stream.
  const now = await read()
  const paused = { ...now.state, status: 'paused', started_at: null, paused_at: Date.now(), accumulated: 60_000 }
  const r = await fetch(`${url}/api/focus/timer`, { method: 'PUT', headers: auth, body: JSON.stringify({ state: paused, base_version: now.version, source: 'tab' }) })
  expect(r.status).toBe(200)
  await expect(panel.getByTestId('focus-timer')).toContainText('paused')
  await expect(tab.getByRole('heading')).toHaveText('Focus is over')
  // A change on an old version is refused with the current state.
  const stale = await fetch(`${url}/api/focus/timer`, { method: 'PUT', headers: auth, body: JSON.stringify({ state: now.state, base_version: now.version, source: 'tab' }) })
  expect(stale.status).toBe(409)
  await panel.getByRole('button', { name: 'Stop' }).click()
  await expect.poll(async () => (await read()).state?.status).toBe('idle')
})
