import { expect, test } from '@playwright/test'
import { answerPrompt, login, signOutAfterEach } from './helpers'

/*
 * Files and tasks stay separate but linked: a file attached to a task opens from the
 * task, and renaming it in Files keeps the attachment working. Files no longer lists
 * the documents folder. Everything made here is removed again.
 */

signOutAfterEach()

test('attach a PDF to a task, open it, rename it in Files', async ({ page }) => {
  await login(page)
  const mark = Date.now()
  const title = `E2E attach ${mark}`
  const name = `e2e-${mark}.pdf`
  const renamed = `e2e-${mark}-final.pdf`
  const task = await (await page.request.post('/api/tasks', { data: { title } })).json()
  try {
    await page.goto(`/tasks`)
    await page.getByRole('button', { name: title, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Task' })
    const attachments = dialog.getByRole('region', { name: 'Attachments' })
    await dialog.getByTestId('task-upload').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%e2e\n') })
    await expect(attachments.getByText(name)).toBeVisible()

    // It opens (downloads) from the task.
    const download = page.waitForEvent('download')
    await attachments.getByTitle('Download').click()
    expect((await download).suggestedFilename()).toBe(name)
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    // Rename it in Files (it went to files/, the task has no project).
    await page.goto('/files?path=files')
    const row = page.locator('div.group', { hasText: name })
    await expect(row).toBeVisible()
    await row.hover()
    await row.getByRole('button', { name: 'Rename' }).click()
    await answerPrompt(page, renamed)
    await expect(page.getByText(renamed, { exact: true })).toBeVisible()

    // The task's attachment follows.
    const files = (await (await page.request.get(`/api/tasks/${task.id}/files`)).json()) as { path: string; exists: boolean }[]
    expect(files).toEqual([expect.objectContaining({ path: `files/${renamed}`, exists: true })])

    // Files lists no documents folder.
    await page.goto('/files?path=.')
    await expect(page.getByText('files', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('documents', { exact: true })).toHaveCount(0)
  } finally {
    await page.request.delete(`/api/tasks/${task.id}`)
    for (const p of [`files/${name}`, `files/${renamed}`]) await page.request.post('/api/files/trash', { data: { path: p } })
  }
})
