import { expect, type Page, test } from '@playwright/test'
import { fakeModels, login, signOutAfterEach } from './helpers'

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

    // A finished task is deleted with one press, and Undo puts it back.
    await page.getByRole('button', { name: `Delete “${title}”` }).click()
    await expect(page.getByRole('checkbox', { name: `Reopen “${title}”` })).toHaveCount(0)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByRole('checkbox', { name: `Reopen “${title}”` })).toBeVisible()
  } finally {
    await deleteTasks(page, title)
  }
})

test('task notes are written with formatting and kept as Markdown', async ({ page }) => {
  const title = `E2E notes ${suffix()}`
  await login(page)
  try {
    await page.goto('/tasks')
    await page.getByRole('button', { name: 'New task' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Title').fill(title)
    const notes = dialog.getByRole('textbox', { name: 'Notes' })
    await notes.click()
    await page.keyboard.type('Call the ')
    await dialog.getByRole('button', { name: 'Bold' }).click()
    await page.keyboard.type('plumber')
    await dialog.getByRole('button', { name: 'Bold' }).click()
    await page.keyboard.press('Enter')
    await dialog.getByRole('button', { name: 'Bullet list' }).click()
    await page.keyboard.type('before noon')
    // Short notes: no images or tables here.
    await expect(dialog.getByRole('button', { name: 'Image' })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Add task' }).click()
    await expect(dialog).toHaveCount(0)

    const tasks = (await (await page.request.get('/api/tasks?status=all')).json()) as { title: string; description: string }[]
    expect(tasks.find((t) => t.title === title)?.description).toBe('Call the **plumber**\n\n- before noon\n')

    // In the list, the arrow shows the start of the notes under the task, and hides it again.
    const arrow = page.getByRole('button', { name: `Notes of “${title}”` })
    await expect(page.getByText('before noon')).toHaveCount(0)
    await arrow.click()
    await expect(arrow).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('main').locator('strong', { hasText: 'plumber' })).toBeVisible()
    await expect(page.getByText('before noon')).toBeVisible()
    await arrow.click()
    await expect(page.getByText('before noon')).toHaveCount(0)

    // Opening it again shows the formatted text. The details are in a panel of their own.
    await page.getByRole('button', { name: title, exact: true }).click()
    await expect(dialog.getByRole('complementary', { name: 'Details' }).getByLabel('Due date')).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: 'Notes' }).locator('strong')).toHaveText('plumber')
    await expect(dialog.getByRole('textbox', { name: 'Notes' }).getByRole('listitem')).toHaveText('before noon')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  } finally {
    await deleteTasks(page, title)
  }
})

test('a task links to a document, and the document links back', async ({ page }) => {
  await login(page)
  await fakeModels(page.request) // creates a document (a file in the workspace): test installs only
  const mark = suffix()
  const taskTitle = `E2E linked ${mark}`
  const docTitle = `E2E plan ${mark}`
  const pickerName = 'Link to a document or task'
  let documentId = ''
  try {
    const doc = (await (await page.request.post('/api/documents', { data: { title: docTitle } })).json()) as { id: string }
    documentId = doc.id

    // In a new task's notes, link to the document.
    await page.goto('/tasks')
    await page.getByRole('button', { name: 'New task' }).click()
    const dialog = page.getByRole('dialog', { name: 'New task', exact: true })
    await dialog.getByLabel('Title').fill(taskTitle)
    const notes = dialog.getByRole('textbox', { name: 'Notes' })
    await notes.click()
    await page.keyboard.type('Read ')
    await dialog.getByRole('button', { name: pickerName }).click()
    const picker = page.getByRole('dialog', { name: pickerName })
    await picker.getByLabel('Search documents and tasks').fill(mark)
    await picker.getByRole('button', { name: new RegExp(docTitle) }).click()
    await expect(picker).toHaveCount(0)

    // Clicking the link keeps the task (as Save would) and opens the document.
    await notes.getByRole('link', { name: docTitle }).click()
    await expect(page).toHaveURL(new RegExp(`/documents/${doc.id}$`))
    const tasks = (await (await page.request.get('/api/tasks?status=all')).json()) as { id: string; title: string; description: string }[]
    const task = tasks.find((t) => t.title === taskTitle)!
    expect(task.description).toBe(`Read [${docTitle}](/documents/${doc.id})\n`)

    // In the document, link back to the task; clicking it opens the task.
    const text = page.getByRole('textbox', { name: 'Document text' })
    await text.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' for ')
    await page.getByRole('button', { name: pickerName }).click()
    await picker.getByLabel('Search documents and tasks').fill(mark)
    await picker.getByRole('button', { name: new RegExp(taskTitle) }).click()
    await text.getByRole('link', { name: taskTitle }).click()
    await expect(page).toHaveURL(new RegExp(`/tasks\\?task=${task.id}`))
    // The link shows the task in the list, marked and with its notes open, not in the editor.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const shownTask = page.locator('[aria-current="true"]')
    await expect(shownTask.getByRole('button', { name: taskTitle, exact: true })).toBeVisible()
    await expect(shownTask.getByRole('link', { name: docTitle })).toBeVisible() // the notes, with their link
    // Opening it is a click away.
    await shownTask.getByRole('button', { name: 'Open task' }).click()
    await expect(page.getByRole('dialog', { name: 'Task', exact: true }).getByLabel('Title')).toHaveValue(taskTitle)
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
    // The document was saved on the way out, with an ordinary Markdown link.
    await expect
      .poll(async () => ((await (await page.request.get(`/api/documents/${doc.id}`)).json()) as { content: string }).content)
      .toContain(`[${taskTitle}](/tasks?task=${task.id})`)
  } finally {
    if (documentId) await page.request.delete(`/api/documents/${documentId}`)
    await deleteTasks(page, taskTitle)
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
      await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: view }).click()
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
