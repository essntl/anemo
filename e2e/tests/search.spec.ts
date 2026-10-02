import { expect, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * Search (the Ctrl+K box and the results page) and the Usage page.
 * The task searched for is created through the API with a unique name and
 * deleted again. Usage is only looked at.
 */

signOutAfterEach()

test('search: Ctrl+K finds a task and a page, the results page filters by kind', async ({ page }) => {
  const word = `zeppelin${Math.random().toString(36).slice(2, 8)}`
  const title = `Repair the ${word}`
  await login(page)
  const created = await page.request.post('/api/tasks', { data: { title, description: 'Bring the big ladder' } })
  const task = (await created.json()) as { id: string }
  try {
    // Jump to a page by name.
    await page.keyboard.press('Control+k')
    const box = page.getByRole('combobox', { name: 'Search' })
    await box.fill('calend')
    await expect(page.getByRole('option', { name: 'Calendar' })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/calendar$/)

    // Find the task; Enter opens it.
    await page.getByRole('button', { name: 'Search everything' }).click()
    await box.fill(word)
    const hit = page.getByRole('option', { name: new RegExp(title) })
    await expect(hit).toBeVisible()
    await expect(hit).toHaveAttribute('aria-selected', 'true') // the first result is selected
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/tasks\\?task=${task.id}`))
    // It is shown in the list, marked and with its notes open; the editor stays closed.
    const shownTask = page.locator('[aria-current="true"]')
    await expect(shownTask.getByRole('button', { name: title, exact: true })).toBeVisible()
    await expect(shownTask.getByText('Bring the big ladder')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // The results page: every word must match, and kinds can be filtered.
    await page.goto(`/search?q=${word}`)
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()
    await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible()
    await page.getByRole('tab', { name: 'Documents' }).click()
    await expect(page).toHaveURL(/kind=document/)
    await expect(page.getByText(`Nothing found for “${word}”`)).toBeVisible()
    await page.getByRole('tab', { name: 'Everything' }).click()
    await page.getByRole('textbox', { name: 'Search', exact: true }).fill(`ladder ${word}`) // found through the description
    await page.keyboard.press('Enter')
    await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible()
  } finally {
    await page.request.delete(`/api/tasks/${task.id}`)
  }
})

test('usage page shows totals, a breakdown and periods', async ({ page }) => {
  await login(page)
  await page.goto('/settings/usage')
  await expect(page.getByRole('heading', { name: 'Usage', exact: true })).toBeVisible()
  await expect(page.getByText('Model calls').first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Breakdown' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Period' }).click()
  await page.getByRole('option', { name: 'All time' }).click()
  await page.getByRole('combobox', { name: 'Group by' }).click()
  await page.getByRole('option', { name: 'By kind of work' }).click()
  await expect(page.getByRole('combobox', { name: 'Group by' })).toHaveText(/By kind of work/)
})
