import { expect, test } from '@playwright/test'
import { fakeModels, login, newChat, send, signOutAfterEach } from './helpers'

/*
 * The activity log in a real browser: the fake agent renames a task, the change shows on
 * /activity as the assistant's, and Undo puts the old title back. The task and the chat
 * are deleted again through the API, also when the test fails.
 */

signOutAfterEach()

const suffix = () => Math.random().toString(36).slice(2, 8)

test("an agent's change to a task shows on Activity, and Undo puts it back", async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  const before = `E2E before ${suffix()}`
  const after = `E2E after ${suffix()}`
  const task = await (await page.request.post('/api/tasks', { data: { title: before } })).json()
  const title = async () => {
    const tasks = (await (await page.request.get('/api/tasks?status=all')).json()) as { id: string; title: string }[]
    return tasks.find((t) => t.id === task.id)?.title
  }
  let chat = ''
  try {
    await newChat(page, 'Agent', models.agent)
    await send(page, `rename task ${task.id} to ${after}`)
    await expect(page).toHaveURL(/\/c\//)
    chat = page.url().replace(/.*\/c\//, '')
    await expect(page.getByText('Renamed it.')).toBeVisible()
    await expect.poll(title).toBe(after)

    await page.goto('/activity')
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
    const entry = page.getByTestId('activity-entry').filter({ hasText: after }).first()
    await expect(entry).toContainText('The assistant in')
    await expect(entry).toContainText('title')
    await entry.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(title).toBe(before)
    // The entry is now marked undone, and the undo has its own entry.
    await expect(page.getByTestId('activity-entry').filter({ hasText: 'Undone' }).first()).toBeVisible()

    // The task's History link opens the page filtered to it.
    await page.goto(`/activity?object_type=task&object_id=${task.id}`)
    await expect(page.getByText('History of one item')).toBeVisible()
    await expect(page.getByTestId('activity-entry')).toHaveCount(3) // created, changed, undone
  } finally {
    await page.request.delete(`/api/tasks/${task.id}`)
    if (chat) await page.request.delete(`/api/conversations/${chat}`)
  }
})
