import { expect, type Page, test } from '@playwright/test'
import { answerPrompt, login, signOutAfterEach } from './helpers'

/*
 * Sketch documents in a real browser: make one, draw a stroke (pointer events on the
 * canvas), see it saved with its image, and embed it in a text document. Both documents
 * have unique names and are removed again (also from the trash), even when the test fails.
 */

signOutAfterEach()

/** Draws a short stroke across the middle of the drawing area with the mouse (the pen is the first tool). */
async function drawStroke(page: Page) {
  const area = page.getByRole('region', { name: 'Drawing sheet' })
  const box = (await area.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x - 60, y - 20)
  await page.mouse.down()
  for (let i = 1; i <= 12; i += 1) await page.mouse.move(x - 60 + i * 10, y - 20 + i * 4)
  await page.mouse.up()
}

test('sketches: draw, autosave with an image, embed in a document', async ({ page }) => {
  const suffix = Math.random().toString(36).slice(2, 8)
  const title = `E2E sketch ${suffix}`
  const docTitle = `E2E sketch host ${suffix}`
  const ids: string[] = []
  const paths: string[] = []
  await login(page)
  try {
    // Made from the list, with its title (an endless sheet by default).
    await page.goto('/documents')
    await page.getByRole('button', { name: 'New sketch', exact: true }).click()
    await answerPrompt(page, title)
    await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/)
    const id = page.url().split('/').pop()!
    ids.push(id)
    await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(title)

    // A stroke is saved by itself, and then its image is uploaded.
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/documents/${id}/sketch`) && r.request().method() === 'PUT')
    const imaged = page.waitForResponse((r) => r.url().endsWith(`/api/documents/${id}/sketch/preview`) && r.request().method() === 'PUT')
    await drawStroke(page)
    expect((await saved).ok()).toBe(true)
    expect((await imaged).ok()).toBe(true)
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect(async () => {
      const doc = await (await page.request.get(`/api/documents/${id}`)).json()
      paths.push(doc.path)
      expect(doc.kind).toBe('sketch')
      expect(doc.path).toMatch(/\.sketch\.md$/)
      expect(doc.sketch.data.items.length).toBeGreaterThan(0)
      expect(doc.sketch.preview_current).toBe(true)
    }).toPass()

    // Listed with the documents, as a drawing.
    await expect(page.getByRole('link', { name: new RegExp(title) })).toContainText('Drawing sheet')

    // Embedded in a text document: its image shows, and the file has the sketch's address.
    await page.getByRole('button', { name: 'New', exact: true }).click()
    await answerPrompt(page, docTitle)
    await page.waitForURL((url) => /\/documents\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(id))
    const docId = page.url().split('/').pop()!
    ids.push(docId)
    const editor = page.getByLabel('Document text')
    await editor.click()
    await page.keyboard.press('Control+End')
    const textSaved = page.waitForResponse((r) => r.url().endsWith(`/api/documents/${docId}`) && r.request().method() === 'PUT')
    await page.getByRole('button', { name: 'Embed a sketch' }).click()
    const picker = page.getByRole('dialog', { name: 'Embed a sketch' })
    await picker.getByRole('textbox').fill(title)
    await picker.getByRole('button', { name: new RegExp(title) }).click()
    await expect(editor.locator(`img[src="/api/documents/${id}/sketch/preview"]`)).toBeVisible()
    await textSaved
    await expect(async () => {
      const doc = await (await page.request.get(`/api/documents/${docId}`)).json()
      paths.push(doc.path)
      expect(doc.content).toContain(`![${title}](/documents/${id})`)
    }).toPass()

    // Its link opens the sketch.
    await editor.getByRole('link', { name: 'Open sketch' }).click()
    await page.waitForURL(new RegExp(`/documents/${id}$`))
    await expect(page.getByRole('region', { name: 'Drawing sheet' })).toBeVisible()
  } finally {
    for (const id of ids) await page.request.delete(`/api/documents/${id}`).catch(() => undefined)
    const trash = (await (await page.request.get('/api/files/trash')).json()) as { id: string; original_path: string }[]
    for (const item of trash.filter((t) => paths.includes(t.original_path))) {
      await page.request.delete(`/api/files/trash/${item.id}`)
    }
  }
})
