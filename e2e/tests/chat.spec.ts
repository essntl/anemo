import { expect, type APIRequestContext, type Page, test } from '@playwright/test'

const USERNAME = process.env.E2E_USERNAME ?? 'admin'
const PASSWORD = process.env.E2E_PASSWORD ?? ''

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(USERNAME)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible()
}

/** Makes sure a fake provider with echo/slow models exists and echo is the default. */
async function ensureFakeModels(request: APIRequestContext): Promise<Record<string, string>> {
  let models = (await (await request.get('/api/models')).json()) as { id: string; model_key: string; provider_type: string }[]
  if (!models.some((m) => m.provider_type === 'fake')) {
    const created = await request.post('/api/providers', { data: { name: 'E2E fake', type: 'fake' } })
    expect(created.ok(), 'fake provider must be enabled (ENABLE_FAKE_PROVIDER=true)').toBeTruthy()
    const { id } = (await created.json()) as { id: string }
    await request.post(`/api/providers/${id}/models/import`, { data: { model_keys: ['echo', 'slow'] } })
    models = await (await request.get('/api/models')).json()
  }
  const byKey = Object.fromEntries(models.filter((m) => m.provider_type === 'fake').map((m) => [m.model_key, m.id]))
  await request.put('/api/settings/models', { data: { chat: byKey.echo } })
  return byKey
}

test('login is required', async ({ page }) => {
  await page.goto('/settings/general')
  await expect(page).toHaveURL(/\/login\?next=/)
})

test('chat streams a reply and survives a reload mid-stream', async ({ page }) => {
  await login(page)
  const models = await ensureFakeModels(page.request)

  // A quick answer with the default model.
  await page.goto('/')
  await page.getByPlaceholder('Message the assistant…').fill('hello e2e')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/c\//)
  await expect(page.getByText('You said: hello e2e')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Regenerate' })).toBeVisible()

  // A slow answer: reload while it streams; it must continue and finish.
  await page.getByLabel('Model').selectOption(models.slow)
  const words = Array.from({ length: 24 }, (_, i) => `w${i}`).join(' ')
  await page.getByPlaceholder('Message the assistant…').fill(words)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
  await expect(page.getByText(/You said: w0 w1/)).toBeVisible()
  await page.reload()
  await expect(page.getByText(`You said: ${words}`)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
})

test('stop cancels the answer and keeps partial text', async ({ page }) => {
  await login(page)
  const models = await ensureFakeModels(page.request)
  await page.goto('/')
  await page.getByLabel('Model').selectOption(models.slow)
  const words = Array.from({ length: 60 }, (_, i) => `s${i}`).join(' ')
  await page.getByPlaceholder('Message the assistant…').fill(words)
  await page.keyboard.press('Enter')
  await expect(page.getByText(/You said: s0 s1/)).toBeVisible()
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByText('Stopped')).toBeVisible()
  await expect(page.getByText(`You said: ${words}`)).toHaveCount(0)
})
