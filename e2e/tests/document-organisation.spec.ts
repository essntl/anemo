import { expect, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * The Documents list organised (docs/specs/26-document-organisation.md): pin from the row
 * menu, archive from the right-click menu (it folds into Archived), group by type. The
 * documents have a unique tag, are found with the search, and are removed afterwards.
 */

signOutAfterEach()

test('documents list: pin, archive and group by type', async ({ page }) => {
  const tag = `Org${Math.random().toString(36).slice(2, 8)}`
  const ids: string[] = []
  await login(page)
  try {
    for (const [title, type] of [[`${tag} alpha`, 'plan'], [`${tag} beta`, null]] as const) {
      const r = await page.request.post('/api/documents', { data: { title, folder: '', properties: type ? { type } : null } })
      expect(r.ok()).toBe(true)
      ids.push(((await r.json()) as { id: string }).id)
    }
    await page.goto('/documents')
    await page.getByRole('textbox', { name: 'Find by title' }).fill(tag)
    const list = page.getByRole('navigation').filter({ has: page.getByRole('link', { name: `${tag} alpha` }) })
    await expect(list.getByRole('link', { name: `${tag} alpha` })).toContainText('Plan') // the type chip

    // Pinned from the row menu: listed first, under Pinned.
    await page.getByRole('link', { name: `${tag} beta` }).hover()
    await page.getByRole('button', { name: `Actions for ${tag} beta` }).click()
    await page.getByRole('button', { name: 'Pin to the top' }).click()
    await expect(list.getByRole('button', { name: /Pinned\s*1/ })).toBeVisible()

    // Archived from the right-click menu: it moves into Archived (a real status change).
    await page.getByRole('link', { name: `${tag} alpha` }).click({ button: 'right' })
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(list.getByRole('button', { name: /Archived\s*1/ })).toBeVisible()
    await expect.poll(async () => ((await (await page.request.get(`/api/documents/${ids[0]}`)).json()) as { properties: { status?: string } }).properties.status).toBe('archived')

    // Group by type: the pinned one stays in Pinned, the archived one in Archived.
    await page.getByRole('combobox', { name: 'Group by' }).click()
    await page.getByRole('option', { name: 'Group by type' }).click()
    await expect(list.getByRole('button', { name: /Pinned\s*1/ })).toBeVisible()
    await expect(list.getByRole('button', { name: /Archived\s*1/ })).toBeVisible()
  } finally {
    for (const id of ids) {
      await page.request.put(`/api/documents/${id}/pin`, { data: { project_id: null, pinned: false } }).catch(() => undefined)
      await page.request.delete(`/api/documents/${id}`).catch(() => undefined)
    }
  }
})
