import { expect, type Page, test } from '@playwright/test'
import { fakeModels, login, newChat, send, signOutAfterEach } from './helpers'

/*
 * Links into a document from an answer: by the document's file (as a model may write
 * it) and to a quoted passage. The link opens the document and highlights the passage.
 * Everything created is removed again.
 */

signOutAfterEach()

const suffix = () => Math.random().toString(36).slice(2, 8)

/** The text the page highlights as "the part a link points at" (CSS Custom Highlight API). */
async function highlighted(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const h = (CSS as unknown as { highlights?: Map<string, Iterable<Range>> }).highlights?.get('passage')
    return h ? [...h].map((r) => r.toString()).join(' ') : null
  })
}

test('a link to a document by its file opens it at the quoted passage', async ({ page }) => {
  await login(page)
  const mark = suffix()
  const folder = `e2e-links-${mark}`
  const content = `# Side Hustle Plan ${mark}\n\n## Scams to watch for\n\n- Fake **payment** confirmations by email\n- Requests for SMS codes\n`
  const created = await page.request.post('/api/documents', { data: { title: `Side Hustle Plan ${mark}`, folder, content } })
  expect(created.ok()).toBe(true)
  const doc = (await created.json()) as { id: string; path: string }
  const models = await fakeModels(page.request)
  let conversationId = ''
  try {
    // An answer that links the file and a passage in it (the echo model repeats this).
    const file = doc.path.replace(/^documents\//, '')
    await newChat(page, 'Chat', models.echo)
    await send(page, `Be careful about the [scams your plan warns about](/documents/${file}#text=fake%20payment%20confirmations).`)
    await expect(page).toHaveURL(/\/c\//)
    conversationId = page.url().split('/c/')[1]

    await page.getByRole('link', { name: 'scams your plan warns about' }).last().click()
    // Opened as the document itself, keeping the part it points at.
    await expect(page).toHaveURL(new RegExp(`/documents/${doc.id}#text=fake%20payment%20confirmations$`))
    await expect(page.getByLabel('Document text')).toContainText('Requests for SMS codes')
    await expect.poll(() => highlighted(page)).toBe('Fake payment confirmations')

    // A section by its heading.
    await page.goto(`/documents/${doc.id}#scams-to-watch-for`)
    await expect.poll(() => highlighted(page)).toBe('Scams to watch for')

    // A file that isn't there says so instead of breaking the page.
    await page.goto(`/documents/${folder}/no-such-plan.md`)
    await expect(page.getByText(`There is no document documents/${folder}/no-such-plan.md.`)).toBeVisible()
    await expect(page.getByRole('link', { name: 'All documents' })).toBeVisible()
  } finally {
    if (conversationId) await page.request.delete(`/api/conversations/${conversationId}`).catch(() => undefined)
    await page.request.delete(`/api/documents/${doc.id}`).catch(() => undefined)
    const trash = (await (await page.request.get('/api/files/trash')).json()) as { id: string; original_path: string }[]
    for (const item of trash.filter((t) => t.original_path === doc.path)) await page.request.delete(`/api/files/trash/${item.id}`)
  }
})
