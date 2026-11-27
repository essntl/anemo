import { expect, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * Tidy up (docs/specs/26-document-organisation.md, feature 5) with the fake model, which
 * suggests archiving documents titled "Prompt: ..." and type `note` for the ones without a
 * type. Only this test's document is chosen and applied; other documents in view are left.
 */

signOutAfterEach()

test('tidy up: review the suggestions and apply one', async ({ page }) => {
  const title = `Prompt: e2e tidy ${Math.random().toString(36).slice(2, 8)}`
  let id = ''
  await login(page)
  try {
    const r = await page.request.post('/api/documents', { data: { title, folder: '' } })
    expect(r.ok()).toBe(true)
    id = ((await r.json()) as { id: string }).id
    await page.goto('/documents')
    await page.getByRole('button', { name: 'Tidy up', exact: true }).click()

    const dialog = page.getByRole('dialog', { name: 'Tidy up' })
    const ours = dialog.getByRole('region', { name: title })
    await expect(ours).toContainText('Archive', { timeout: 20_000 })
    await dialog.getByRole('button', { name: 'Reject all' }).click()
    await ours.getByRole('checkbox').first().check()
    await dialog.getByRole('button', { name: 'Apply 1 selected' }).click()
    await expect(page.getByText(/1 change made/)).toBeVisible()
    await expect(dialog).toHaveCount(0)

    // A real status change, through the normal path: the document's history has it.
    const doc = (await (await page.request.get(`/api/documents/${id}`)).json()) as { properties: { status?: string } }
    expect(doc.properties.status).toBe('archived')
  } finally {
    if (id) await page.request.delete(`/api/documents/${id}`).catch(() => undefined)
  }
})
