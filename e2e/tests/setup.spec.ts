import { expect, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * The first-run setup, opened from Settings → Advanced (a test install already has a
 * provider, so it is never offered on its own), and the update notice on the same page
 * (a test build has no commit and no way to GitHub). Changes nothing it doesn't put
 * back: the setup's progress is restored, and no step is saved with new values.
 */

signOutAfterEach()

type Setup = { status: string; step: string | null }

async function setupState(request: import('@playwright/test').APIRequestContext): Promise<Setup> {
  return ((await (await request.get('/api/settings')).json()) as { setup: Setup }).setup
}

test('the setup walks through its steps, remembers where it was, and finishes', async ({ page }) => {
  await login(page)
  const before = await setupState(page.request)
  const settingsBefore = await (await page.request.get('/api/settings')).json()
  try {
    // A test install has a provider, so the setup isn't offered when Anemo is opened.
    const status = (await (await page.request.get('/api/setup/status')).json()) as { offer_setup: boolean }
    expect(status.offer_setup).toBe(false)

    await page.goto('/settings/advanced')
    await page.getByRole('link', { name: /^(Start|Continue|Open) setup$/ }).click()
    await expect(page).toHaveURL(/\/setup$/)
    await expect(page.getByRole('heading', { name: 'Set up Anemo', level: 1 })).toBeVisible()
    const steps = page.getByRole('navigation', { name: 'Setup steps' })
    await steps.getByRole('button', { name: 'Step 1: Model provider' }).click()

    // 1. The provider that is there, and the model for chats.
    const step = page.locator('#setup-step')
    await expect(step).toHaveText('Model provider')
    await expect(page.getByRole('combobox', { name: 'Model for chats' })).toBeVisible()
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    // 2. Helper models: optional, skipped (nothing saved).
    await expect(step).toHaveText(/^Helper models/)
    await expect(page.getByRole('combobox', { name: 'Summaries' })).toBeVisible()
    await page.getByRole('button', { name: 'Skip', exact: true }).click()

    // 3. You: unchanged values aren't saved again.
    await expect(step).toHaveText('You')
    await expect(page.getByRole('textbox', { name: 'Time zone' })).toHaveValue(settingsBefore.general.timezone)
    await expect.poll(async () => (await setupState(page.request)).step).toBe('you')
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    // 4. Optional parts: each says whether it runs.
    await expect(step).toHaveText(/^Optional parts/)
    const parts = page.getByRole('list', { name: 'Optional parts' })
    await expect(parts).toContainText('Shell sandbox')
    await expect(parts).toContainText('Web search (SearXNG)')
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    // 5. Notifications, then back and forward again.
    await expect(step).toHaveText(/^Notifications/)
    await expect(page.getByRole('switch', { name: 'Push notifications on this device' })).toBeVisible()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(step).toHaveText(/^Optional parts/)
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('button', { name: 'Finish', exact: true }).click()

    await expect(page).toHaveURL(/\/home$/)
    await expect.poll(async () => await setupState(page.request)).toEqual({ status: 'done', step: null })
    const after = await (await page.request.get('/api/settings')).json()
    expect(after.general).toEqual(settingsBefore.general)
    expect(after.models).toEqual(settingsBefore.models)

    // Finished: Advanced offers it again; "Not now" leaves it finished.
    await page.goto('/settings/advanced')
    await page.getByRole('link', { name: 'Open setup' }).click()
    await page.getByRole('button', { name: 'Not now', exact: true }).click()
    await expect(page).toHaveURL(/\/home$/)
    expect((await setupState(page.request)).status).toBe('done')
  } finally {
    await page.request.put('/api/settings/setup', { data: before })
  }
})

test('Advanced says plainly when a build can’t be compared for updates', async ({ page }) => {
  await login(page)
  const before = ((await (await page.request.get('/api/settings')).json()) as { updates: { check: boolean } }).updates
  try {
    await page.goto('/settings/advanced')
    const card = page.locator('div.rounded-card', { has: page.getByRole('heading', { name: 'Updates', exact: true }) })
    await expect(card).toContainText('can’t be compared with main')
    await expect(card.getByRole('button', { name: 'Check now' })).toHaveCount(0)

    // The switch is saved on the server.
    const toggle = card.getByRole('switch', { name: 'Check for updates' })
    await expect(toggle).toBeChecked({ checked: before.check })
    await toggle.click()
    await expect(toggle).toBeChecked({ checked: !before.check })
    await expect
      .poll(async () => ((await (await page.request.get('/api/settings')).json()) as { updates: { check: boolean } }).updates.check)
      .toBe(!before.check)
    const updates = (await (await page.request.get('/api/updates')).json()) as { commit: string | null; notice: boolean }
    expect(updates.commit).toBeNull()
    expect(updates.notice).toBe(false)
  } finally {
    await page.request.put('/api/settings/updates', { data: before })
  }
})
