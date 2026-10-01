import { expect, test } from '@playwright/test'
import { confirmWith, login, signOutAfterEach } from './helpers'

/*
 * Automations and notifications in a real browser.
 *
 * These run against an instance that may be in real use, so no automation is
 * ever started here (that would call the user's real model): the one created is
 * scheduled a year ahead and deleted again. The notification test uses a task
 * reminder, which involves no model, and is skipped if it would be sent on to
 * a real Discord channel.
 */

signOutAfterEach()

const suffix = () => Math.random().toString(36).slice(2, 8)
const pad = (n: number) => String(n).padStart(2, '0')

test('automations: create, see the schedule, turn off, edit and delete', async ({ page }) => {
  const name = `E2E automation ${suffix()}`
  const nextYear = new Date().getFullYear() + 1
  await login(page)
  try {
    await page.goto('/automations')
    await page.getByRole('button', { name: 'New', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name').fill(name)
    await dialog.getByLabel('What should it do?').fill('Say hello.')

    // The preview explains the schedule and refuses one that runs too often.
    await expect(dialog.getByText('At 08:00 every day')).toBeVisible()
    await dialog.getByRole('combobox').first().click()
    await page.getByRole('option', { name: 'Custom (cron)' }).click()
    await dialog.getByLabel('Cron expression').fill('* * * * *')
    await expect(dialog.getByText(/at most every 5 minutes/)).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Create automation' })).toBeDisabled()

    // Once, a year from now: it cannot fire during this test.
    await dialog.getByRole('combobox').first().click()
    await page.getByRole('option', { name: 'Once', exact: true }).click()
    await dialog.getByLabel('On', { exact: true }).fill(`${nextYear}-06-15`)
    await dialog.getByLabel('At', { exact: true }).fill('09:30')
    await expect(dialog.getByText(new RegExp(`Once on .* ${nextYear} at 09:30`))).toBeVisible()
    await dialog.getByRole('button', { name: 'Create automation' }).click()
    await expect(dialog).toHaveCount(0)

    const card = page.locator('div.rounded-card', { hasText: name })
    await expect(card.getByText(new RegExp(`Once on .* ${nextYear}`))).toBeVisible()
    await card.getByRole('button', { name: 'History' }).click()
    await expect(card.getByText('It has not run yet.')).toBeVisible()

    // Off: no next run is shown any more.
    await card.getByRole('switch').click()
    await expect(card.getByText('· off')).toBeVisible()

    await card.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('button', { name: 'Edit' }).click()
    await expect(dialog.getByLabel('At', { exact: true })).toHaveValue('09:30')
    await dialog.getByLabel('Name').fill(`${name} renamed`)
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toHaveCount(0)
    const renamed = page.locator('div.rounded-card', { hasText: `${name} renamed` })
    await expect(renamed).toBeVisible()

    await renamed.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('button', { name: 'Delete' }).click()
    await confirmWith(page, 'Delete')
    await expect(page.getByText(name)).toHaveCount(0)
  } finally {
    const all = (await (await page.request.get('/api/automations')).json()) as { id: string; name: string }[]
    for (const a of all.filter((x) => x.name.startsWith(name))) await page.request.delete(`/api/automations/${a.id}`)
  }
})

test('a reminder arrives as a notification and opens what it is about', async ({ page }) => {
  test.setTimeout(90_000)
  const title = `E2E reminder ${suffix()}`
  await login(page)
  type Destination = { enabled: boolean; kinds: string[] }
  const destinations = (await (await page.request.get('/api/notification-destinations')).json()) as Destination[]
  test.skip(
    destinations.some((d) => d.enabled && d.kinds.includes('reminder')),
    'A Discord channel receives reminders: this test would post to it',
  )

  // A task due this minute, in the time zone the server uses for tasks.
  const settings = (await (await page.request.get('/api/settings')).json()) as { general: { timezone: string } }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: settings.general.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date())
  const get = (type: string) => parts.find((p) => p.type === type)!.value
  const created = await page.request.post('/api/tasks', {
    data: {
      title,
      due_date: `${get('year')}-${get('month')}-${get('day')}`,
      due_time: `${pad(Number(get('hour')))}:${get('minute')}`,
      remind_minutes: 0,
    },
  })
  expect(created.ok()).toBeTruthy()
  const task = (await created.json()) as { id: string }
  try {
    await page.goto('/notifications')
    // The worker checks for due reminders every half minute.
    // (Scoped to the page: the same text also appears in a pop-up notice.)
    const row = page.locator('main div.rounded-card', { hasText: `Reminder: ${title}` })
    await expect(row).toBeVisible({ timeout: 60_000 })
    await expect(row.getByLabel('Unread')).toBeVisible()
    await row.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(page).toHaveURL(/\/tasks/)

    await page.goto('/notifications')
    await expect(row).toBeVisible()
    await expect(row.getByLabel('Unread')).toHaveCount(0) // opening it marked it as read
    await row.getByRole('button', { name: 'Delete notification' }).click()
    await expect(row).toHaveCount(0)
  } finally {
    await page.request.delete(`/api/tasks/${task.id}`)
    const notes = (await (await page.request.get('/api/notifications')).json()) as { id: string; title: string }[]
    for (const n of notes.filter((x) => x.title.includes(title))) await page.request.delete(`/api/notifications/${n.id}`)
  }
})

test('notification settings: desktop notifications and the Discord dialog', async ({ page }) => {
  await login(page)
  await page.goto('/settings/notifications')
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Desktop notifications' })).toBeVisible()
  await page.getByRole('button', { name: 'Add' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Webhook URL')).toHaveAttribute('type', 'password')
  await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled() // nothing entered yet
  await expect(dialog.getByLabel('Results of automations')).toBeChecked()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
})
