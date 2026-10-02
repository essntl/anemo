import { expect, test } from '@playwright/test'
import { fakeModels, login, signOutAfterEach } from './helpers'

/*
 * Model capabilities in Settings. Needs the fake provider (skips without it), and
 * puts back what it changes.
 */

signOutAfterEach()

test('a model’s capabilities can be corrected by hand', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request) // skips without the fake provider
  await page.goto('/settings/providers')
  const open = page.getByRole('button', { name: 'Change what Echo can do' })
  await expect(open).not.toContainText('Vision')
  try {
    await open.click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('switch', { name: 'Vision for Echo' }).click()
    await expect(dialog.getByRole('switch', { name: 'Vision for Echo' })).toBeChecked()
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(open).toContainText('Vision')
  } finally {
    await page.request.patch(`/api/models/${models.echo}`, { data: { capabilities: { vision: false } } })
  }
})
