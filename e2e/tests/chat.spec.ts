import { expect, type APIRequestContext, type Page, test } from '@playwright/test'

/*
 * These tests run against a live instance that may also be in real use, so they
 * never change the user's settings: they pick the mode and model explicitly in
 * the UI, and anything they must change temporarily is restored afterwards.
 */

const USERNAME = process.env.E2E_USERNAME ?? 'admin'
const PASSWORD = process.env.E2E_PASSWORD ?? ''

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(USERNAME)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible()
}

/** Makes sure a fake provider with the echo/slow/agent models exists; returns their ids. */
async function fakeModels(request: APIRequestContext): Promise<Record<string, string>> {
  const wanted = ['echo', 'slow', 'agent']
  const providers = (await (await request.get('/api/providers')).json()) as { id: string; type: string }[]
  let fake = providers.find((p) => p.type === 'fake')
  if (!fake) {
    const created = await request.post('/api/providers', { data: { name: 'E2E fake', type: 'fake' } })
    expect(created.ok(), 'fake provider must be enabled (ENABLE_FAKE_PROVIDER=true)').toBeTruthy()
    fake = (await created.json()) as { id: string; type: string }
  }
  type M = { id: string; model_key: string; provider_id: string }
  const list = async () =>
    ((await (await request.get('/api/models')).json()) as M[]).filter((m) => m.provider_id === fake.id)
  let models = await list()
  const missing = wanted.filter((k) => !models.some((m) => m.model_key === k))
  if (missing.length) {
    await request.post(`/api/providers/${fake.id}/models/import`, { data: { model_keys: missing } })
    models = await list()
  }
  return Object.fromEntries(models.map((m) => [m.model_key, m.id]))
}

/** Opens a new chat with an explicit mode and model. */
async function newChat(page: Page, mode: 'Chat' | 'Agent', modelId: string) {
  await page.goto('/')
  await page.getByRole('radio', { name: mode }).click()
  await page.getByLabel('Model').selectOption(modelId)
}

async function send(page: Page, text: string) {
  await page.getByPlaceholder('Message the assistant…').fill(text)
  await page.keyboard.press('Enter')
}

test('login is required', async ({ page }) => {
  await page.goto('/settings/general')
  await expect(page).toHaveURL(/\/login\?next=/)
})

test('chat streams a reply and survives a reload mid-stream', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)

  await newChat(page, 'Chat', models.echo)
  await send(page, 'hello e2e')
  await expect(page).toHaveURL(/\/c\//)
  await expect(page.getByText('You said: hello e2e')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Regenerate' })).toBeVisible()

  // A slow answer: reload while it streams; it must continue and finish.
  await page.getByLabel('Model').selectOption(models.slow)
  const words = Array.from({ length: 24 }, (_, i) => `w${i}`).join(' ')
  await send(page, words)
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
  await expect(page.getByText(/You said: w0 w1/)).toBeVisible()
  await page.reload()
  await expect(page.getByText(`You said: ${words}`)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
})

test('stop cancels the answer and keeps partial text', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  await newChat(page, 'Chat', models.slow)
  const words = Array.from({ length: 60 }, (_, i) => `s${i}`).join(' ')
  await send(page, words)
  await expect(page.getByText(/You said: s0 s1/)).toBeVisible()
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByText('Stopped')).toBeVisible()
  await expect(page.getByText(`You said: ${words}`)).toHaveCount(0)
})

test('attach a text file and the model receives its content', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  await newChat(page, 'Chat', models.echo)
  await page.locator('input[type=file]').setInputFiles({
    name: 'shopping.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('eggs, flour, sugar'),
  })
  await expect(page.getByText('shopping.txt')).toBeVisible()
  await expect(page.getByText('Uploading…')).toHaveCount(0)
  await send(page, 'what is on my list')
  await expect(page).toHaveURL(/\/c\//)
  // The fake model echoes everything it received, including the attachment text.
  await expect(page.getByText(/eggs, flour, sugar/).last()).toBeVisible()
  await expect(page.getByRole('link', { name: /shopping\.txt/ })).toBeVisible()
})

test('agent asks for approval, then finishes after approval', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  // Make file listing require approval for this test; restore the user's settings after.
  const previous = ((await (await page.request.get('/api/settings')).json()) as {
    permissions: { levels?: Record<string, string> }
  }).permissions
  const changed = await page.request.put('/api/settings/permissions', {
    data: { ...previous, levels: { ...previous.levels, 'fs.read': 'ask' } },
  })
  expect(changed.ok()).toBeTruthy()
  try {
    await newChat(page, 'Agent', models.agent)
    await send(page, 'what is in my workspace?')
    await expect(page.getByText('Waiting for your approval')).toBeVisible()
    await expect(page.getByText(/The agent wants to: List/)).toBeVisible()
    await page.getByRole('button', { name: 'Allow once' }).click()
    await expect(page.getByText('Here is what I found:')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: /\d+ actions?$/ })).toBeVisible()
  } finally {
    await page.request.put('/api/settings/permissions', { data: previous })
  }
})
