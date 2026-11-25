import { expect, test } from '@playwright/test'
import { fakeModels, login, signOutAfterEach } from './helpers'

/*
 * MCP triggers (docs/specs/17-mcp-triggers.md) in a real browser: an automation gets a
 * trigger on an MCP server's notifications from the Automations page, with the server
 * picked by name and a resource URI. The e2e stack has no MCP server that notifies (the
 * listener and the firing are covered by backend/tests/api/test_mcp_triggers.py), so the
 * server here points at a port where nothing listens. Everything made here is deleted.
 */

signOutAfterEach()

const suffix = () => Math.random().toString(36).slice(2, 8)

test('mcp triggers: pick the server and the resource in the trigger dialog', async ({ page }) => {
  const name = `E2E on notes ${suffix()}`
  const serverName = `E2E notes ${suffix()}`
  await login(page)
  const models = await fakeModels(page.request)
  let automationId: string | null = null
  let serverId: string | null = null
  try {
    const server = await page.request.post('/api/mcp/servers', {
      data: { name: serverName, transport: 'http', url: 'http://127.0.0.1:9/mcp' },
    })
    expect(server.status()).toBe(201)
    serverId = ((await server.json()) as { id: string }).id
    const created = await page.request.post('/api/automations', {
      data: {
        name,
        prompt: 'Look at the changed note.',
        schedule: { kind: 'manual', tz: 'UTC' },
        model_id: models.agent,
        tool_allowlist: ['list_files'],
        notify: 'never',
      },
    })
    expect(created.status()).toBe(201)
    automationId = ((await created.json()) as { id: string }).id

    await page.goto('/automations')
    const card = page.locator('div.rounded-card', { hasText: name })
    await card.getByRole('button', { name: 'Add a trigger' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('combobox', { name: /^Event/ }).click()
    await page.getByRole('option', { name: 'MCP server notification' }).click()
    await expect(dialog.getByRole('spinbutton', { name: /^Coalesce bursts/ })).toHaveValue('30')
    await expect(dialog.getByRole('button', { name: 'Add trigger' })).toBeDisabled() // no server yet
    await dialog.getByRole('combobox', { name: /^MCP server/ }).click()
    await page.getByRole('option', { name: serverName }).click()
    await dialog.getByRole('textbox', { name: 'Resource URI' }).fill('note://a')
    await dialog.getByRole('button', { name: 'Add trigger' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(card.getByText('Also runs when')).toBeVisible()
    await expect(card.getByText(/uri: note:\/\/a/)).toBeVisible()

    const triggers = (await (await page.request.get(`/api/triggers?automation_id=${automationId}`)).json()) as {
      event_type: string
      filter: Record<string, unknown>
      debounce_s: number
    }[]
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({
      event_type: 'mcp.notification', filter: { server_id: serverId, uri: 'note://a' }, debounce_s: 30,
    })
  } finally {
    if (automationId) await page.request.delete(`/api/automations/${automationId}`)
    if (serverId) await page.request.delete(`/api/mcp/servers/${serverId}`)
  }
})
