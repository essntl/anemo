import { expect, test } from '@playwright/test'
import { confirmWith, login, signOutAfterEach } from './helpers'

/*
 * Automation scripts (docs/specs/08-automation-scripts.md) in a real browser: write one
 * in the Scripts tab, read its code, run it (no model: the code only logs and returns,
 * in the worker's Deno sandbox), see the run in its history, switch it on and off,
 * delete it.
 *
 * A change written by an assistant (the diff review) needs a scripted model, so it is
 * covered by the backend's API tests and the tab's component tests instead.
 */

signOutAfterEach()

const suffix = () => Math.random().toString(36).slice(2, 8)

const CODE = `export default async function main(input, anemo) {
  anemo.log("hello from e2e")
  return { outcome: "E2E script ran", trigger: input.trigger }
}`

test('scripts: write one, read its code, run it, switch it, delete it', async ({ page }) => {
  const name = `E2E script ${suffix()}`
  await login(page)
  try {
    await page.goto('/automations')
    await page.getByRole('tab', { name: 'Scripts' }).click()
    await expect(page).toHaveURL(/tab=scripts/)
    await page.getByRole('button', { name: 'New script' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name', { exact: true }).fill(name)
    await dialog.getByLabel('What it does').fill('Says hello.')
    await dialog.getByLabel('Code (TypeScript)').fill(CODE)
    await expect(dialog.getByText('It runs when you press Run now, when an assistant starts it, or when one of its event triggers fires.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Create script' }).click()
    await expect(dialog).toHaveCount(0)

    const card = page.getByTestId('script-card').filter({ hasText: name })
    await expect(card.getByText('Only when started')).toBeVisible()
    await expect(card.getByText('Written by you')).toBeVisible()

    // The code as approved: the only code it runs.
    await card.getByRole('button', { name: 'Code', exact: true }).click()
    const review = page.getByRole('dialog')
    await expect(review.getByText('This is the approved code: the only code this script runs.')).toBeVisible()
    await expect(review.getByLabel('Code')).toContainText('hello from e2e')
    await review.getByRole('button', { name: 'Close' }).first().click()
    await expect(review).toHaveCount(0)

    // Run it: the run log shows how it went, with its outcome line.
    await card.getByRole('button', { name: 'Run now' }).click()
    await card.getByRole('button', { name: 'History' }).click()
    await expect(card.getByText('E2E script ran')).toBeVisible({ timeout: 30_000 })

    // Approved and without a change waiting: it can be switched on, and off again.
    const toggle = card.getByRole('switch')
    await toggle.click()
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect(card.getByText('· off')).toBeVisible()

    await card.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('button', { name: 'Delete' }).click()
    await confirmWith(page, 'Delete')
    await expect(page.getByText(name)).toHaveCount(0)
  } finally {
    const all = (await (await page.request.get('/api/automations')).json()) as { id: string; name: string }[]
    for (const a of all.filter((x) => x.name.startsWith(name))) await page.request.delete(`/api/automations/${a.id}`)
  }
})
