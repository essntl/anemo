import { expect, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * Document properties: set one from the properties bar above the text (it lands in the
 * file's front matter), find the document with a filter typed into search, save that
 * search as a view and see the document in it. Everything created is removed again.
 */

signOutAfterEach()

const suffix = () => Math.random().toString(36).slice(2, 8)

test('a property set in the editor filters search and fills a view', async ({ page }) => {
  await login(page)
  const mark = suffix()
  const created = await page.request.post('/api/documents', {
    data: { title: `Brief ${mark}`, folder: `e2e-props-${mark}`, content: `# Brief ${mark}\n\nThe price for ${mark}.\n` },
  })
  expect(created.ok()).toBe(true)
  const doc = (await created.json()) as { id: string; path: string }
  let viewId = ''
  try {
    await page.goto(`/documents/${doc.id}`)
    // + Property > Type > Brief
    await page.getByRole('button', { name: 'Property', exact: true }).click()
    await page.getByRole('button', { name: 'Type', exact: true }).click()
    await page.getByRole('button', { name: 'Brief', exact: true }).click()
    await expect(page.getByRole('button', { name: /Type:\s*Brief/ })).toBeVisible()
    const saved = (await (await page.request.get(`/api/documents/${doc.id}`)).json()) as { content: string }
    expect(saved.content).toMatch(/^---\ntype: brief\n---\n/)

    // A filter typed into search becomes a chip, and only finds what has the value.
    await page.goto(`/search?q=${encodeURIComponent(`type:brief ${mark}`)}`)
    await expect(page.getByRole('list', { name: 'Filters' })).toContainText('Type: Brief')
    await expect(page.getByRole('link', { name: new RegExp(`Brief ${mark}`) })).toBeVisible()
    await page.goto(`/search?q=${encodeURIComponent(`type:brif ${mark}`)}`)
    await expect(page.getByRole('list', { name: 'Filters' })).toContainText('did you mean brief?')

    // Saved as a view, which lists the document.
    await page.goto(`/search?q=${encodeURIComponent(`type:brief ${mark}`)}`)
    await page.getByRole('button', { name: 'Save as view' }).click()
    await page.getByRole('dialog').getByRole('textbox').fill(`Briefs ${mark}`)
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
    await expect(page).toHaveURL(/\/views\//)
    viewId = page.url().split('/views/')[1]
    await expect(page.getByRole('link', { name: new RegExp(`Brief ${mark}`) })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Views' })).toContainText(`Briefs ${mark}`)
  } finally {
    if (viewId) await page.request.delete(`/api/views/${viewId}`)
    await page.request.delete(`/api/documents/${doc.id}`)
  }
})
