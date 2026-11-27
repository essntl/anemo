import { expect, test } from '@playwright/test'
import { confirmWith, fakeModels, login, newChat, send, signOutAfterEach } from './helpers'

/*
 * Event triggers (docs/specs/16-event-triggers.md) in a real browser: an automation that
 * runs only on events gets a trigger from the Automations page, a new task fires it, and
 * its run shows in the run log with the event that started it. And a chat that asked to
 * be woken sets its next wake-me in the turn the event started.
 *
 * The automation's runs use the fake provider's demo agent (never a real model), and
 * everything made here is deleted again.
 */

signOutAfterEach()

const suffix = () => Math.random().toString(36).slice(2, 8)

test('triggers: a new task starts the automation, and its run says which event', async ({ page }) => {
  const name = `E2E on tasks ${suffix()}`
  const title = `E2E trigger task ${suffix()}`
  await login(page)
  const models = await fakeModels(page.request)
  let automationId: string | null = null
  let taskId: string | null = null
  try {
    const created = await page.request.post('/api/automations', {
      data: {
        name,
        prompt: 'Look at the new task.',
        schedule: { kind: 'manual', tz: 'UTC' },
        model_id: models.agent,
        tool_allowlist: ['list_files'],
        notify: 'never',
      },
    })
    expect(created.status()).toBe(201)
    automationId = ((await created.json()) as { id: string }).id

    await page.goto('/automations')
    const card = page.locator('div.rounded-card', { hasText: name })
    await expect(card.getByText('Only when started')).toBeVisible()
    await card.getByRole('button', { name: 'Add a trigger' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('A task was created.')).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
    await dialog.getByRole('button', { name: 'Add trigger' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(card.getByText('Also runs when')).toBeVisible()
    await expect(card.getByText(`title: ${title}`)).toBeVisible()

    // Another task: the filter keeps it from firing. Then the one it waits for.
    await page.request.post('/api/tasks', { data: { title: `${title} (not this one)` } })
    const task = await page.request.post('/api/tasks', { data: { title } })
    taskId = ((await task.json()) as { id: string }).id

    await card.getByRole('button', { name: 'History' }).click()
    await expect(async () => {
      await page.reload()
      const reloaded = page.locator('div.rounded-card', { hasText: name })
      await reloaded.getByRole('button', { name: 'History' }).click()
      await expect(reloaded.getByText(`Task created: ${title}`, { exact: true })).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 60_000 })
    const runs = (await (await page.request.get(`/api/automations/${automationId}/runs`)).json()) as { trigger: string }[]
    expect(runs).toHaveLength(1)
    expect(runs[0].trigger).toBe('event')

    // Removing the trigger asks first.
    const again = page.locator('div.rounded-card', { hasText: name })
    await again.getByRole('button', { name: 'Remove the trigger' }).click()
    await confirmWith(page, 'Remove')
    await expect(again.getByText('Also runs when')).toHaveCount(0)
  } finally {
    if (taskId) await page.request.delete(`/api/tasks/${taskId}`)
    const tasks = (await (await page.request.get('/api/tasks')).json()) as { id: string; title: string }[]
    for (const tk of tasks.filter((x) => x.title.startsWith(title))) await page.request.delete(`/api/tasks/${tk.id}`)
    if (automationId) {
      // A run that is still going holds the automation: give it a moment to end.
      await expect(async () => {
        expect((await page.request.delete(`/api/automations/${automationId}`)).status()).not.toBe(409)
      }).toPass({ timeout: 30_000 })
    }
  }
})

test('triggers: a woken chat waits for the next event by itself', async ({ page }) => {
  const word = `e2e-watch-${suffix()}`
  await login(page)
  const models = await fakeModels(page.request)
  let chatId: string | null = null
  const tasks: string[] = []
  try {
    await newChat(page, 'Agent', models.agent)
    await send(page, `watch for tasks titled ${word}`)
    const watching = page.getByText(/Watching\. This chat will be woken on/)
    await expect(watching).toHaveCount(1)
    await expect(page).toHaveURL(/\/c\//)
    chatId = new URL(page.url()).pathname.split('/').pop() ?? null

    // Twice: the second time only because the first woken turn set a new wake-me.
    for (const round of [1, 2]) {
      const task = await page.request.post('/api/tasks', { data: { title: word } })
      tasks.push(((await task.json()) as { id: string }).id)
      await expect(page.getByText('An event woke this chat')).toHaveCount(round, { timeout: 60_000 })
      await expect(watching).toHaveCount(round + 1, { timeout: 60_000 })
    }
    const waiting = (await (await page.request.get(`/api/triggers?conversation_id=${chatId}`)).json()) as { enabled: boolean }[]
    expect(waiting.map((t) => t.enabled)).toEqual([false, false, true])
  } finally {
    // Deleting the chat takes its triggers with it.
    if (chatId) await page.request.delete(`/api/conversations/${chatId}`)
    for (const id of tasks) await page.request.delete(`/api/tasks/${id}`)
  }
})
