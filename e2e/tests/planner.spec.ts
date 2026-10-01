import { expect, type Page, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * Tasks and Calendar in a real browser. Everything created has a unique name
 * and is deleted again through the API, also when a test fails.
 */

signOutAfterEach()

const suffix = () => Math.random().toString(36).slice(2, 8)
const pad = (n: number) => String(n).padStart(2, '0')
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

async function deleteTasks(page: Page, title: string) {
  const tasks = (await (await page.request.get('/api/tasks?status=all')).json()) as { id: string; title: string }[]
  for (const t of tasks.filter((x) => x.title === title)) await page.request.delete(`/api/tasks/${t.id}`)
}

test('tasks: quick add, due date, complete, board', async ({ page }) => {
  const title = `E2E task ${suffix()}`
  await login(page)
  try {
    await page.goto('/tasks')
    await page.getByLabel('Add a task').fill(title)
    await page.keyboard.press('Enter')
    const row = page.getByRole('button', { name: title, exact: false }).first()
    await expect(row).toBeVisible()

    // Give it a due date of today: it moves to the "Today" section.
    await row.click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Due date').fill(day(new Date()))
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /Today/ })).toBeVisible()

    // The board shows it under "To do".
    await page.getByRole('radio', { name: 'Board' }).click()
    await expect(page).toHaveURL(/view=board/)
    await expect(page.getByRole('region', { name: 'To do' }).getByText(title)).toBeVisible()
    await page.getByRole('radio', { name: 'List' }).click()

    // Completing it moves it to "Finished".
    await page.getByRole('checkbox', { name: `Complete “${title}”` }).click()
    await page.getByRole('button', { name: /Finished/ }).click()
    await expect(page.getByRole('checkbox', { name: `Reopen “${title}”` })).toBeVisible()
  } finally {
    await deleteTasks(page, title)
  }
})

test('calendar: add an event, see it, open and delete it', async ({ page }) => {
  const title = `E2E event ${suffix()}`
  await login(page)
  try {
    await page.goto('/calendar')
    await page.getByRole('button', { name: 'New event' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Title').fill(title)
    await dialog.getByLabel('Location').fill('Test room')
    await dialog.getByRole('button', { name: 'Add event' }).click()
    await expect(dialog).toHaveCount(0)

    // It is on today's date in every view.
    for (const view of ['Month', 'Week', 'Agenda']) {
      await page.getByRole('combobox', { name: 'View' }).click()
      await page.getByRole('option', { name: view }).click()
      await expect(page.locator('.fc').getByText(title).first()).toBeVisible()
    }
    await page.locator('.fc').getByText(title).first().click()
    await expect(dialog.getByLabel('Location')).toHaveValue('Test room')
    await dialog.getByRole('button', { name: 'Delete' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('.fc').getByText(title)).toHaveCount(0)
  } finally {
    const now = new Date()
    const start = new Date(now.getTime() - 3 * 86_400_000).toISOString()
    const end = new Date(now.getTime() + 3 * 86_400_000).toISOString()
    const found = (await (await page.request.get(`/api/calendar/events?start=${start}&end=${end}`)).json()) as {
      event_id: string
      title: string
    }[]
    for (const o of found.filter((x) => x.title === title)) await page.request.delete(`/api/calendar/events/${o.event_id}`)
  }
})
