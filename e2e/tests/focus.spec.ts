import { expect, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * The focus timer: linked to a task, started, fast-forwarded to its end (Playwright's
 * clock), and recorded on the server. Everything it creates is removed again.
 */

signOutAfterEach()

test('start a focus session for a task and finish it', async ({ page }) => {
  await page.clock.install()
  await login(page)
  const focus = (await (await page.request.get('/api/settings')).json()).focus as { focus_minutes: number }
  const task = await (await page.request.post('/api/tasks', { data: { title: `E2E focus ${Date.now()}` } })).json()
  try {
    await page.goto('/focus')
    await expect(page.getByRole('radio', { name: 'Focus' })).toHaveAttribute('aria-checked', 'true')

    // Link the task.
    await page.getByRole('button', { name: 'Link a task' }).click()
    await page.getByRole('combobox', { name: 'Find a task' }).fill(task.title)
    await page.getByRole('option', { name: task.title }).click()
    await expect(page.getByRole('link', { name: task.title })).toBeVisible()

    await page.getByRole('button', { name: 'Start timer' }).click()
    await expect(page.getByRole('button', { name: 'Pause timer' })).toBeVisible()

    // The whole phase passes (as if the tab had been in the background).
    await page.clock.fastForward(focus.focus_minutes * 60_000 + 2_000)
    await expect(page.getByRole('radio', { name: 'Focus' })).toHaveAttribute('aria-checked', 'false')

    // The session is stored on the server, for the task, as finished.
    await expect
      .poll(async () => {
        const sessions = (await (await page.request.get(`/api/focus/sessions?task_id=${task.id}`)).json()) as {
          minutes: number
          completed: boolean
        }[]
        return sessions.map((s) => [s.minutes, s.completed])
      })
      .toEqual([[focus.focus_minutes, true]])
    await expect(page.getByTestId('focus-today')).not.toHaveText('0m')
  } finally {
    const sessions = (await (await page.request.get(`/api/focus/sessions?task_id=${task.id}`)).json()) as { id: string }[]
    for (const s of sessions) await page.request.delete(`/api/focus/sessions/${s.id}`)
    await page.request.delete(`/api/tasks/${task.id}`)
  }
})

test('the timer keeps going across pages and a reload', async ({ page }) => {
  const t0 = Date.now()
  await page.clock.install()
  await login(page)
  await page.goto('/focus')
  await page.getByRole('button', { name: 'Start timer' }).click()
  await page.clock.fastForward(60_000)
  await page.goto('/tasks')
  await page.reload()
  await page.goto('/focus')
  // Still running, about a minute in (the clock is worked out, not counted).
  await expect(page.getByRole('button', { name: 'Pause timer' })).toBeVisible()
  const focus = (await (await page.request.get('/api/settings')).json()).focus as { focus_minutes: number }
  const shown = await page.locator('.sr-only', { hasText: /^\d+:\d\d$/ }).first().textContent()
  const [m] = (shown ?? '').split(':').map(Number)
  expect(m).toBe(focus.focus_minutes - 2)
  await page.getByRole('button', { name: 'Reset timer' }).click()
  // Reset after a minute records the minute as a session cut short: remove it.
  type S = { id: string; completed: boolean; started_at: string }
  const ours = async () =>
    ((await (await page.request.get(`/api/focus/sessions?start=${new Date(t0 - 1000).toISOString()}`)).json()) as S[])
      .filter((s) => !s.completed)
  await expect.poll(async () => (await ours()).length).toBe(1)
  for (const s of await ours()) await page.request.delete(`/api/focus/sessions/${s.id}`)
})

test('start and pause focus from the search box, edit Home from it', async ({ page }) => {
  await login(page)
  await page.goto('/stats')
  await expect(page.getByRole('heading', { name: 'Stats' })).toBeVisible()
  const run = async (typed: string, option: string) => {
    await page.keyboard.press('Control+k')
    await page.getByRole('combobox', { name: 'Search' }).fill(typed)
    await page.getByRole('option', { name: option, exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
  const status = () => page.evaluate(() => JSON.parse(localStorage.getItem('anemo-timer') ?? '{}').state?.timer?.status as string)
  await run('start focus', 'Start focus')
  // Running, shown in the Island; the page stays where it was.
  await expect.poll(status).toBe('running')
  await expect(page.getByRole('button', { name: /Show controls/ })).toBeVisible()
  await expect(page).toHaveURL(/\/stats/)
  await run('pause timer', 'Pause or resume the timer')
  await expect.poll(status).toBe('paused')

  await run('focus', 'Focus')
  await expect(page).toHaveURL(/\/focus$/)
  await page.getByRole('button', { name: 'Reset timer' }).click()

  await run('home layout', 'Edit home layout')
  await expect(page).toHaveURL(/\/home$/)
  await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
})
