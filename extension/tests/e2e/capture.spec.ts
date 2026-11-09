import type { Page } from '@playwright/test'
import { choose, expect, test } from './fixtures'
import { addCapture } from './mockCapture'
import { addChat } from './mockChat'
import { addEvents } from './mockEvents'

let cap: ReturnType<typeof addCapture>
let article: Page

test.beforeEach(async ({ panel, anemo, context }) => {
  addChat(anemo)
  const events = addEvents(anemo)
  cap = addCapture(anemo, events)
  await panel.getByLabel('Anemo address').fill(anemo.url)
  await panel.getByLabel('API token').fill('anemo_good-token')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('What can I help with?')).toBeVisible()
  await expect.poll(() => events.sockets.size, { timeout: 10_000 }).toBe(1)
  article = await context.newPage()
  await article.goto(`${anemo.url}/article`)
  await article.bringToFront()
  await panel.getByRole('button', { name: 'Capture' }).click()
})

test('save the page as a new document: progress, then View and Undo', async ({ panel }) => {
  await panel.getByRole('button', { name: /Save page/ }).click()
  await expect(panel.getByTestId('capture-source')).toContainText('Photosynthesis explained')
  await panel.getByRole('radio', { name: 'A summary' }).click()
  await panel.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(panel.getByText(/Formatting with Anemo/)).toBeVisible()
  await expect(panel.getByTestId('capture-done')).toContainText('Saved to Photosynthesis explained')
  const body = cap.captures[0] as { kind: string; format: string; target: { mode: string; folder: string }; page: { content: string } }
  expect(body).toMatchObject({ kind: 'page', format: 'summary', target: { mode: 'new', folder: 'Web clips' } })
  expect(body.page.content).toContain('plants turn **light**')
  await expect(panel.getByRole('link', { name: 'View' })).toHaveAttribute('href', /\/documents\/new-doc$/)
  await panel.getByRole('button', { name: 'Undo' }).click()
  await expect(panel.getByTestId('capture-done')).toContainText('Undone.')
  expect(cap.undone).toEqual(['delete new-doc'])
})

test('save the selection into the Inbox (the default), with its page link', async ({ panel }) => {
  await article.evaluate(() => {
    const p = document.querySelectorAll('article p')[2]
    const range = document.createRange()
    range.selectNodeContents(p)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
  await panel.getByRole('button', { name: /Save selection/ }).click()
  await expect(panel.getByRole('listbox', { name: 'Save to' }).getByRole('option', { name: /Inbox/ })).toHaveAttribute('aria-selected', 'true')
  await panel.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(panel.getByTestId('capture-done')).toContainText('Saved to Inbox')
  const body = cap.captures[0] as { kind: string; target: unknown; page: { source: string; content: string; url: string } }
  expect(body.kind).toBe('selection')
  expect(body.target).toEqual({ mode: 'append', document_id: null })
  expect(body.page.source).toBe('selection')
  expect(body.page.content).toBe('Paragraph 2: plants turn light into chemical energy stored in glucose, releasing oxygen.')
  expect(body.page.url).toMatch(/\/article$/)
  await panel.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => cap.undone).toEqual(['restore inbox rev-1'])
})

test('add the page to an existing document', async ({ panel }) => {
  await panel.getByRole('button', { name: /Save page/ }).click()
  await panel.getByRole('listbox', { name: 'Save to' }).getByRole('option', { name: /Biology notes/ }).click()
  await panel.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(panel.getByTestId('capture-done')).toContainText('Saved to Biology notes')
  expect((cap.captures[0] as { target: unknown }).target).toEqual({ mode: 'append', document_id: 'd1' })
})

test('Save selection with nothing selected says so', async ({ panel }) => {
  await panel.getByRole('button', { name: /Save selection/ }).click()
  await expect(panel.getByText('Nothing is selected')).toBeVisible()
})

test('quick task: title from the page, link in the notes, no due date, the project is remembered', async ({ panel }) => {
  await panel.getByRole('button', { name: /Quick task/ }).click()
  await expect(panel.getByLabel('Title')).toHaveValue('Photosynthesis explained')
  await expect(panel.getByLabel('Due date')).toHaveValue('')
  await choose(panel, 'Project', 'Thesis')
  await panel.getByRole('button', { name: 'Create task' }).click()
  await expect(panel.getByTestId('task-done')).toContainText('Task created')
  const task = cap.tasks[0] as { title: string; description: string; due_date: string | null; project_id: string }
  expect(task.title).toBe('Photosynthesis explained')
  expect(task.due_date).toBeNull()
  expect(task.project_id).toBe('p1')
  expect(task.description).toMatch(/^From \[Photosynthesis explained\]\(http:\/\/127\.0\.0\.1:\d+\/article\)/)
  await panel.getByRole('button', { name: 'Make another' }).click()
  await panel.getByRole('button', { name: /Quick task/ }).click()
  await expect(panel.getByRole('combobox', { name: 'Project' })).toHaveText('Thesis')
})
