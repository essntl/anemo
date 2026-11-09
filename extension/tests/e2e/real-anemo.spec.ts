/**
 * Against a real Anemo, when one is given (skipped otherwise):
 *   ANEMO_E2E_URL=http://127.0.0.1:8099 ANEMO_E2E_TOKEN=anemo_… npm run e2e
 * The URL must be on 127.0.0.1 (the test build may reach only that without a prompt).
 * Use a throwaway install: the tests create chats in it.
 */
import { expect, test } from './fixtures'

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
    await expect(panel.getByRole('list', { name: 'Chats' }).getByRole('button').first()).toBeVisible()
  })

  test('stop ends a slow answer', async ({ panel }) => {
    await panel.getByLabel('Model').selectOption({ label: 'Slow echo' })
    await panel.getByLabel('Message').fill('one two three four five six seven eight nine ten eleven twelve')
    await panel.getByRole('button', { name: 'Send' }).click()
    await expect(panel.getByRole('button', { name: 'Stop' })).toBeVisible()
    await panel.getByRole('button', { name: 'Stop' }).click()
    await expect(panel.getByText('Stopped.')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible()
  })

  test('the agent asks a question; answering it lets the run finish', async ({ panel }) => {
    await panel.getByRole('radio', { name: 'agent' }).click()
    await panel.getByLabel('Model').selectOption({ label: 'Demo agent' })
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
