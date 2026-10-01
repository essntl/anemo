import { expect, test } from '@playwright/test'
import { confirmWith, login, signOutAfterEach } from './helpers'

/*
 * The Browser panel: watching and using the agent's browser from a chat.
 * Needs the optional browser container (docker compose --profile browser up -d)
 * and internet access (it opens example.com); skipped without the container.
 * No model is involved: the user opens the page themselves.
 */

signOutAfterEach()

test('browser panel: open a page, use it, pop it out and close it', async ({ page }) => {
  await login(page)
  const status = (await (await page.request.get('/api/browser/status')).json()) as { available: boolean }
  test.skip(!status.available, 'The browser container is not running')
  const created = await page.request.post('/api/conversations', { data: { title: 'E2E browser panel' } })
  const conversation = (await created.json()) as { id: string }
  try {
    await page.goto(`/c/${conversation.id}`)
    await page.getByRole('button', { name: 'Browser', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'The agent’s browser' })
    await expect(panel.getByText('No page is open yet')).toBeVisible()

    // Open a page from the address field ("example.com" gets https://).
    await panel.getByLabel('Address').fill('example.com')
    await panel.getByLabel('Address').press('Enter')
    const picture = panel.getByRole('img', { name: 'Example Domain' })
    await expect(picture).toBeVisible({ timeout: 30_000 })
    await panel.getByRole('application').focus() // leave the address field, so it shows the page's address
    await expect(panel.getByLabel('Address')).toHaveValue('https://example.com/')

    // Click the page's only link (found by where it is in the real page), in the scaled picture.
    const size = await picture.boundingBox()
    expect(size!.width).toBeGreaterThan(300)
    const state = await page.request.post(`/api/conversations/${conversation.id}/browser/input`, {
      data: { kind: 'key', key: 'Tab' }, // focus the link, as a user could with the keyboard
    })
    expect(state.ok()).toBeTruthy()
    await panel.getByRole('application').press('Enter')
    await expect(panel.getByLabel('Address')).not.toHaveValue('https://example.com/', { timeout: 30_000 })
    await panel.getByRole('button', { name: 'Back' }).click()
    await expect(panel.getByLabel('Address')).toHaveValue('https://example.com/', { timeout: 30_000 })

    // The same browser on a page of its own (what "separate window" and phones show).
    await page.goto(`/browser/${conversation.id}`)
    await expect(page.getByRole('img', { name: 'Example Domain' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Close browser' }).click()
    await confirmWith(page, 'Close browser')
    await expect(page.getByText('No page is open yet')).toBeVisible()
  } finally {
    await page.request.delete(`/api/conversations/${conversation.id}`)
  }
})
