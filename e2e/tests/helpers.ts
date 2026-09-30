import { expect, type APIRequestContext, type Page, test } from '@playwright/test'

/*
 * Shared helpers. These tests run against a live instance that may also be in
 * real use, so they never change the user's settings: they pick the mode and model
 * explicitly in the UI, and anything they must change temporarily is restored.
 */

export const USERNAME = process.env.E2E_USERNAME ?? 'admin'
export const PASSWORD = process.env.E2E_PASSWORD ?? ''

export async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(USERNAME)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
  await expect(page.getByRole('radiogroup', { name: 'Mode' })).toBeVisible()
}

/**
 * Returns the ids of the fake provider's echo/slow/agent models, importing any that
 * are missing. Skips the test when no enabled fake provider exists: the tests must
 * never create or enable providers, or run against a real (paid) model.
 */
export async function fakeModels(request: APIRequestContext): Promise<Record<string, string>> {
  const wanted = ['echo', 'slow', 'agent']
  type P = { id: string; type: string; enabled: boolean }
  const providers = (await (await request.get('/api/providers')).json()) as P[]
  const fake = providers.find((p) => p.type === 'fake' && p.enabled)
  test.skip(!fake, 'Needs an enabled fake provider (ENABLE_FAKE_PROVIDER=true, added in Settings)')
  type M = { id: string; model_key: string; provider_id: string }
  const list = async () =>
    ((await (await request.get('/api/models')).json()) as M[]).filter((m) => m.provider_id === fake!.id)
  let models = await list()
  const missing = wanted.filter((k) => !models.some((m) => m.model_key === k))
  if (missing.length) {
    await request.post(`/api/providers/${fake!.id}/models/import`, { data: { model_keys: missing } })
    models = await list()
  }
  return Object.fromEntries(models.map((m) => [m.model_key, m.id]))
}

/** Opens a new chat with an explicit mode and model. */
export async function newChat(page: Page, mode: 'Chat' | 'Agent', modelId: string) {
  await page.goto('/')
  await page.getByRole('radio', { name: mode }).click()
  await pickModel(page, modelId)
}

/** Chooses a model in the composer's model dropdown. */
export async function pickModel(page: Page, modelId: string) {
  await page.getByRole('combobox', { name: 'Model' }).click()
  await page.locator(`[role="option"][data-value="${modelId}"]`).click()
}

/** Types an answer into the app's name dialog (e.g. "New folder") and submits it. */
export async function answerPrompt(page: Page, value: string) {
  const box = page.getByRole('dialog').getByRole('textbox')
  await box.fill(value)
  await box.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

/** Clicks the confirm button of the app's confirmation dialog. */
export async function confirmWith(page: Page, label: string) {
  await page.getByRole('dialog').getByRole('button', { name: label }).click()
}

export async function send(page: Page, text: string) {
  await page.getByPlaceholder('Message the assistant…').fill(text)
  await page.keyboard.press('Enter')
}

/** Sign out after each test, so test logins don't pile up under Settings > Active sessions. */
export function signOutAfterEach() {
  test.afterEach(async ({ page }) => {
    await page.request.post('/api/auth/logout').catch(() => undefined)
  })
}
