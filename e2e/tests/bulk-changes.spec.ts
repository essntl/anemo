import { expect, test } from '@playwright/test'
import { fakeModels, login, newChat, send, signOutAfterEach } from './helpers'

signOutAfterEach()

type Task = { id: string; title: string; due_date: string | null }

test('a batch change of tasks asks once, lists every task, and changes them all', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  const stamp = `bulk${Date.now()}`
  const made: Task[] = []
  for (const n of [1, 2, 3, 4]) {
    const r = await page.request.post('/api/tasks', { data: { title: `Errand ${n} ${stamp}` } })
    expect(r.ok()).toBeTruthy()
    made.push((await r.json()) as Task)
  }
  // Changing tasks asks first in this test; restore the user's settings after.
  const previous = ((await (await page.request.get('/api/settings')).json()) as {
    permissions: { levels?: Record<string, string> }
  }).permissions
  const changed = await page.request.put('/api/settings/permissions', {
    data: { ...previous, levels: { ...previous.levels, 'tasks.write': 'ask' } },
  })
  expect(changed.ok()).toBeTruthy()
  try {
    await newChat(page, 'Agent', models.agent)
    // The fake agent model lists the tasks matching the words, then moves them all in one call.
    await send(page, `postpone my tasks: ${stamp}`)
    await expect(page.getByText('The agent wants to: Change 4 tasks: due → Fri 2030-01-04')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Show all 4 items' }).click()
    const list = page.getByRole('list', { name: 'Items in this batch' })
    for (const task of made) await expect(list.getByRole('link', { name: task.title })).toBeVisible()
    await expect(list.getByText('due → Fri 2030-01-04')).toHaveCount(4)

    await page.getByRole('button', { name: 'Allow once' }).click()
    await expect(page.getByText('Postponed. 4 of 4 tasks done.')).toBeVisible({ timeout: 15_000 })
    for (const task of made) {
      const now = (await (await page.request.get('/api/tasks', { params: { status: 'all', q: stamp } })).json()) as Task[]
      expect(now.find((t) => t.id === task.id)?.due_date).toBe('2030-01-04')
    }
  } finally {
    await page.request.put('/api/settings/permissions', { data: previous })
    for (const task of made) await page.request.delete(`/api/tasks/${task.id}`)
    if (page.url().includes('/c/')) await page.request.delete(page.url().replace(/.*\/c\//, '/api/conversations/'))
  }
})
