import { expect, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * Tasks and events join in (spec 01, phase 3) in a real browser: an event links to a
 * document and shows on it under "Linked from"; "Create meeting notes" makes a document
 * linked both ways. Everything created is deleted again through the API.
 */

signOutAfterEach()

const suffix = () => Math.random().toString(36).slice(2, 8)

test('an event linked to a brief shows on the brief, and gets meeting notes', async ({ page }) => {
  const mark = suffix()
  await login(page)
  const brief = await (
    await page.request.post('/api/documents', {
      data: { title: `E2E brief ${mark}`, folder: `e2e-linking-${mark}`, content: `# E2E brief ${mark}\n` },
    })
  ).json()
  const start = new Date(Date.now() + 3 * 86_400_000)
  start.setHours(10, 0, 0, 0)
  const event = await (
    await page.request.post('/api/calendar/events', {
      data: { title: `E2E meeting ${mark}`, start_at: start.toISOString(), tz: 'UTC' },
    })
  ).json()
  let notesId = ''
  try {
    const linked = await page.request.post(`/api/links/event/${event.id}`, { data: { to: [`/documents/${brief.id}`] } })
    expect(linked.ok()).toBe(true)

    await page.goto(`/documents/${brief.id}`)
    await expect(page.getByLabel('Linked from').getByRole('link', { name: `E2E meeting ${mark}` }).first()).toBeVisible()

    await page.goto(`/calendar?event=${event.id}`)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('region', { name: 'Links' }).getByText(`E2E brief ${mark}`)).toBeVisible()
    await dialog.getByRole('button', { name: 'Create meeting notes' }).click()
    await expect(page).toHaveURL(/\/documents\//)
    notesId = page.url().split('/documents/')[1].split(/[?#]/)[0]
    await expect(page.getByLabel('Linked from').getByRole('link', { name: `E2E meeting ${mark}` }).first()).toBeVisible()
  } finally {
    await page.request.delete(`/api/calendar/events/${event.id}`)
    await page.request.delete(`/api/documents/${brief.id}`)
    if (notesId) await page.request.delete(`/api/documents/${notesId}`)
  }
})
