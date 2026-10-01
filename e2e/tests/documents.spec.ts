import { expect, test } from '@playwright/test'
import { answerPrompt, confirmWith, login, signOutAfterEach } from './helpers'

/*
 * Documents in a real browser: the rich editor, autosave, picking up a change
 * made elsewhere, history and delete. The test document has a unique name and
 * is removed again (also from the trash), even when the test fails.
 */

signOutAfterEach()

test('documents: write, autosave, outside changes, history and delete', async ({ page }) => {
  const title = `E2E doc ${Math.random().toString(36).slice(2, 8)}`
  let id = ''
  let path = ''
  await login(page)
  try {
    await page.goto('/documents')
    await page.getByRole('button', { name: 'New', exact: true }).click()
    await answerPrompt(page, title)
    await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/)
    id = page.url().split('/').pop()!

    // Type into the rich editor; it saves by itself.
    const editor = page.getByLabel('Document text')
    await expect(editor.getByRole('heading', { name: title })).toBeVisible()
    await editor.click()
    await page.keyboard.press('Control+End')
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/documents/${id}`) && r.request().method() === 'PUT')
    await page.keyboard.type('Hello from the browser test.')
    await page.getByRole('button', { name: 'Bold' }).click()
    await page.keyboard.type(' Bold words.')
    await saved
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect(async () => {
      const doc = await (await page.request.get(`/api/documents/${id}`)).json()
      path = doc.path
      expect(doc.content).toContain(`# ${title}`)
      expect(doc.content).toContain('Hello from the browser test. **Bold words.**')
    }).toPass()

    // Changed elsewhere (as an agent would) while nothing is unsaved here: it shows up.
    const current = await (await page.request.get(`/api/documents/${id}`)).json()
    await page.request.put(`/api/documents/${id}`, {
      data: { content: `${current.content}\nAdded from outside.\n`, base_hash: current.hash },
    })
    await expect(editor.getByText('Added from outside.')).toBeVisible()

    // The Markdown source view shows the same file text.
    await page.getByRole('radio', { name: 'Markdown' }).click()
    await expect(page.locator('.cm-content')).toContainText(`# ${title}`)
    await page.getByRole('radio', { name: 'Rich text' }).click()

    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('button', { name: 'History' }).click()
    const history = page.getByRole('dialog')
    await expect(history.getByText('You', { exact: false }).first()).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('button', { name: 'Delete' }).click()
    await confirmWith(page, 'Delete')
    await page.waitForURL(/\/documents$/)
    await expect(page.getByRole('link', { name: title })).toHaveCount(0)
  } finally {
    if (id) await page.request.delete(`/api/documents/${id}`).catch(() => undefined)
    const trash = (await (await page.request.get('/api/files/trash')).json()) as { id: string; original_path: string }[]
    for (const item of trash.filter((t) => path && t.original_path === path)) {
      await page.request.delete(`/api/files/trash/${item.id}`)
    }
  }
})
