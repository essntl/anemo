import { expect, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * Sources and provenance in a real browser: an event's link (/calendar?event=<id>) opens
 * the event on its day, and a task shows who made it. Everything created is deleted again
 * through the API, also when the test fails.
 */

signOutAfterEach()

const suffix = () => Math.random().toString(36).slice(2, 8)

test("an event's link opens it, and a task says who made it", async ({ page }) => {
  const title = `E2E linked event ${suffix()}`
  const taskTitle = `E2E made by me ${suffix()}`
  await login(page)
  const start = new Date(Date.now() + 3 * 86_400_000)
  start.setHours(10, 0, 0, 0)
  const event = await (
    await page.request.post('/api/calendar/events', {
      data: { title, start_at: start.toISOString(), tz: 'UTC' },
    })
  ).json()
  const task = await (await page.request.post('/api/tasks', { data: { title: taskTitle } })).json()
  try {
    await page.goto(`/calendar?event=${event.id}`)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Title')).toHaveValue(title)
    await expect(dialog.getByText('Created by you.')).toBeVisible()
    // Closing it takes the event out of the address.
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(page).not.toHaveURL(/event=/)

    // A link to an event that isn't there says so, above the calendar, and nothing opens.
    await page.goto('/calendar?event=00000000-0000-7000-8000-000000000000')
    await expect(page.getByRole('status').getByText('Event not found. It may have been deleted.')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await page.goto(`/tasks?task=${task.id}`)
    await expect(page.getByRole('dialog').getByText('Created by you.')).toBeVisible()
  } finally {
    await page.request.delete(`/api/calendar/events/${event.id}`)
    await page.request.delete(`/api/tasks/${task.id}`)
  }
})
