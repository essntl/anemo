import { expect, type Page, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * A task's checklist, its subtasks and the tasks it waits on ("blocked by"), in a real
 * browser. Everything created has a unique name and is deleted again through the API,
 * also when a test fails.
 */

signOutAfterEach()

const suffix = () => Math.random().toString(36).slice(2, 8)

type ApiTask = { id: string; title: string; status: string; parent_id: string | null; blocked_by: string[]; checklist: { text: string; done: boolean }[] }

async function allTasks(page: Page): Promise<ApiTask[]> {
  return (await (await page.request.get('/api/tasks?status=all')).json()) as ApiTask[]
}

async function byTitle(page: Page, title: string): Promise<ApiTask> {
  const found = (await allTasks(page)).find((t) => t.title === title)
  if (!found) throw new Error(`no task “${title}”`)
  return found
}

async function deleteTasks(page: Page, mark: string) {
  for (const t of (await allTasks(page)).filter((x) => x.title.includes(mark))) {
    await page.request.delete(`/api/tasks/${t.id}`)
  }
}

async function quickAdd(page: Page, title: string) {
  await page.getByLabel('Add a task').fill(title)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: title, exact: false }).first()).toBeVisible()
}

/** Opens a task from the list in the editor. */
async function open(page: Page, title: string) {
  await page.getByRole('button', { name: title, exact: false }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Task', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

test('a checklist, a subtask and a task it waits on', async ({ page }) => {
  const mark = suffix()
  const parent = `E2E move ${mark}`
  const sub = `E2E book a van ${mark}`
  const blocker = `E2E find a flat ${mark}`
  await login(page)
  try {
    await page.goto('/tasks')
    await quickAdd(page, parent)
    await quickAdd(page, blocker)

    // A checklist: two items, one ticked. The list shows how far it is.
    let dialog = await open(page, parent)
    const add = dialog.getByLabel('Add a checklist item')
    await add.fill('Pack the books')
    await add.press('Enter')
    await dialog.getByLabel('Add a checklist item').fill('Label the boxes')
    await dialog.getByLabel('Add a checklist item').press('Enter')
    await dialog.getByRole('checkbox', { name: 'Done: Pack the books' }).check()
    await expect(dialog.getByText('1/2')).toBeVisible()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: new RegExp(parent) }).getByLabel('Checklist: 1 of 2 done')).toBeVisible()
    expect((await byTitle(page, parent)).checklist).toEqual([
      expect.objectContaining({ text: 'Pack the books', done: true }),
      expect.objectContaining({ text: 'Label the boxes', done: false }),
    ])

    // A subtask, added in the editor. In the list it is folded in under its task.
    dialog = await open(page, parent)
    await dialog.getByLabel('Add a subtask').fill(sub)
    await dialog.getByLabel('Add a subtask').press('Enter')
    await expect(dialog.getByRole('region', { name: 'Subtasks' }).getByText(sub)).toBeVisible()

    // It waits on another task: chosen from a list, saved with the task.
    await dialog.getByRole('button', { name: 'Choose a task it waits on' }).click()
    const picker = page.getByRole('dialog', { name: 'Waits on' })
    await picker.getByLabel('Search tasks').fill(mark)
    // Not the task itself (nor anything that waits on it: that would make a loop).
    await expect(picker.getByRole('option', { name: parent })).toHaveCount(0)
    await picker.getByRole('option', { name: blocker }).click()
    await expect(picker).toHaveCount(0)
    await expect(dialog.getByRole('region', { name: 'Waits on' }).getByText(blocker)).toBeVisible()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toHaveCount(0)

    const saved = await byTitle(page, parent)
    expect(saved.status).toBe('blocked')
    expect(saved.blocked_by).toEqual([(await byTitle(page, blocker)).id])
    expect((await byTitle(page, sub)).parent_id).toBe(saved.id)
    await expect(page.getByLabel(`Waits on ${blocker}`)).toBeVisible()

    // The subtask is not on its own in the list; the arrow folds it out.
    await expect(page.getByRole('checkbox', { name: `Complete “${sub}”` })).toHaveCount(0)
    await page.getByRole('button', { name: `Subtasks of “${parent}”` }).click()
    await expect(page.getByRole('group', { name: `Subtasks of “${parent}”` }).getByRole('checkbox', { name: `Complete “${sub}”` })).toBeVisible()

    // Finishing what it waits on: it is "to do" again, and a notification says so.
    await page.getByRole('checkbox', { name: `Complete “${blocker}”` }).click()
    await expect(page.getByLabel(`Waits on ${blocker}`)).toHaveCount(0)
    await expect.poll(async () => (await byTitle(page, parent)).status).toBe('todo')
    // The list holds only the newest notifications, and other tests add theirs at the
    // same time: ask for the most it gives and wait for ours rather than reading it once.
    await expect
      .poll(async () => {
        const notes = (await (await page.request.get('/api/notifications?limit=200')).json()) as { title: string }[]
        return notes.some((n) => n.title === `Ready to start: ${parent}`)
      })
      .toBe(true)

    // Finishing the task asks about its open subtask; finish it too.
    await page.getByRole('checkbox', { name: `Complete “${parent}”` }).click()
    const ask = page.getByRole('dialog', { name: 'It has an open subtask' })
    await ask.getByRole('option', { name: 'Finish it too' }).click()
    await expect.poll(async () => (await byTitle(page, sub)).status).toBe('done')
    expect((await byTitle(page, parent)).status).toBe('done')
  } finally {
    await deleteTasks(page, mark)
  }
})

test.describe('on the board', () => {
  // Wide enough to show "To do" and "Done" side by side (a drag can't scroll the board).
  test.use({ viewport: { width: 1800, height: 900 } })

  test('the board asks before finishing a task with open subtasks', async ({ page }) => {
    const mark = suffix()
    const parent = `E2E launch ${mark}`
    const sub = `E2E write the post ${mark}`
    await login(page)
    try {
      const created = (await (await page.request.post('/api/tasks', { data: { title: parent } })).json()) as ApiTask
      await page.request.post('/api/tasks', { data: { title: sub, parent_id: created.id } })
      await page.goto('/tasks?view=board')
      const todo = page.getByRole('region', { name: 'To do' })
      const done = page.getByRole('region', { name: 'Done' })
      // The subtask's card names its task too, so pick the cards by what they don't say.
      const parentCard = todo.locator('[draggable="true"]').filter({ hasText: parent }).filter({ hasNotText: sub })
      const subCard = todo.locator('[draggable="true"]').filter({ hasText: sub })
      await expect(parentCard).toBeVisible()
      await expect(subCard).toContainText(parent) // "↳ its task"
      // Drag by events on the card itself, not by mouse position: other tests add tasks
      // to "To do" meanwhile, and a card moving under the mouse would drag another one.
      // (The card is held as an element: once the dialog opens, the board is hidden
      // from role queries.)
      const transfer = await page.evaluateHandle(() => new DataTransfer())
      const card = await parentCard.elementHandle()
      await card!.dispatchEvent('dragstart', { dataTransfer: transfer })
      await done.dispatchEvent('dragover', { dataTransfer: transfer })
      await done.dispatchEvent('drop', { dataTransfer: transfer })
      await card!.dispatchEvent('dragend', { dataTransfer: transfer })
      const ask = page.getByRole('dialog', { name: 'It has an open subtask' })
      await expect(ask).toBeVisible()
      // Keep it open: the task moves, its subtask stays.
      await ask.getByRole('option', { name: 'Keep it open' }).click()
      await expect.poll(async () => (await byTitle(page, parent)).status).toBe('done')
      expect((await byTitle(page, sub)).status).toBe('todo')
      await expect(subCard).toBeVisible()
    } finally {
      await deleteTasks(page, mark)
    }
  })
})
