import { expect, test } from '@playwright/test'
import { confirmWith, login, signOutAfterEach } from './helpers'

/*
 * Settings > MCP in a real browser. The server added here points at a port where
 * nothing listens, so it never connects and offers no tools; it is removed again.
 */

signOutAfterEach()

test('mcp settings: add a server, see why it fails, edit and remove it', async ({ page }) => {
  const name = `E2E mcp ${Math.random().toString(36).slice(2, 8)}`
  await login(page)
  try {
    await page.goto('/settings/mcp')
    await expect(page.getByRole('heading', { name: 'MCP', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    const dialog = page.getByRole('dialog')

    // A local program: a pasted command line is split into program and arguments.
    await dialog.getByRole('combobox').click()
    await page.getByRole('option', { name: /Local program/ }).click()
    await dialog.getByLabel('Command').fill('npx -y some-server')
    await dialog.getByLabel('Arguments').click()
    await expect(dialog.getByLabel('Command')).toHaveValue('npx')
    await expect(dialog.getByLabel('Arguments')).toHaveValue('-y\nsome-server')
    await dialog.getByLabel(/Environment variables/).fill('not a pair')
    await expect(dialog.getByText(/Not “name= value”/)).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Add server' })).toBeDisabled()

    // A remote server that is not there.
    await dialog.getByRole('combobox').click()
    await page.getByRole('option', { name: 'Remote server (URL)' }).click()
    await dialog.getByPlaceholder('e.g. GitHub').fill(name)
    await dialog.getByPlaceholder('https://example.com/mcp').fill('http://127.0.0.1:9/mcp')
    await dialog.getByLabel(/Headers/).fill('Authorization: Bearer e2e-not-a-real-key')
    await dialog.getByRole('button', { name: 'Add server' }).click()
    await expect(dialog).toHaveCount(0)

    const card = page.locator('main div.rounded-card', { hasText: name })
    await expect(card.getByText('Not working')).toBeVisible({ timeout: 45_000 })
    await expect(card.getByText(/Could not connect/)).toBeVisible()
    await card.getByRole('button', { name: /0 tools/ }).click()
    await expect(card.getByText('No tools found yet.')).toBeVisible()

    // The saved header is named, never shown.
    await card.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('button', { name: 'Edit' }).click()
    await expect(dialog.getByText(/Saved: Authorization\./)).toBeVisible()
    await expect(dialog.getByLabel(/Headers/)).toHaveValue('')
    expect(await page.content()).not.toContain('e2e-not-a-real-key')
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    await card.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('button', { name: 'Remove' }).click()
    await confirmWith(page, 'Remove')
    await expect(page.getByText(name)).toHaveCount(0)
  } finally {
    const all = (await (await page.request.get('/api/mcp/servers')).json()) as { id: string; name: string }[]
    for (const s of all.filter((x) => x.name === name)) await page.request.delete(`/api/mcp/servers/${s.id}`)
  }
})
