import { EXTENSION_ID, expect, test } from './fixtures'

test('the extension loads with its fixed id and opens on the setup screen', async ({ extensionId, panel }) => {
  expect(extensionId).toBe(EXTENSION_ID)
  await expect(panel.getByRole('heading', { name: 'Connect to Anemo' })).toBeVisible()
})

test('connects with a valid token, then goes back to setup when it is revoked', async ({ panel, anemo }) => {
  await panel.getByLabel('Anemo address').fill(anemo.url)
  await panel.getByLabel('API token').fill('anemo_good-token')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
  expect(anemo.log).toContain('POST /api/permissions/preview')

  // Revoked in Anemo: the next request is a 401 and the panel says so.
  anemo.tokens.clear()
  await panel.reload()
  await expect(panel.getByText('The token stopped working')).toBeVisible()
  await expect(panel.getByLabel('Anemo address')).toHaveValue(anemo.url)
})

test('says which step failed: a wrong token, then Anemo refusing the extension', async ({ panel, anemo }) => {
  await panel.getByLabel('Anemo address').fill(anemo.url)
  await panel.getByLabel('API token').fill('anemo_wrong')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('The token doesn’t work')).toBeVisible()

  anemo.routes.set('POST /api/permissions/preview', (_req, _b, res) => {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'bad_origin', message: 'blocked' } }))
  })
  await panel.getByLabel('API token').fill('anemo_good-token')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('Anemo refuses requests from this extension')).toBeVisible()
})

test('says when nothing answers at the address', async ({ panel }) => {
  await panel.getByLabel('Anemo address').fill('http://127.0.0.1:9')
  await panel.getByLabel('API token').fill('anemo_good-token')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('Nothing answered at this address')).toBeVisible()
})

test('disconnect revokes the token and returns to setup', async ({ panel, anemo }) => {
  await panel.getByLabel('Anemo address').fill(anemo.url)
  await panel.getByLabel('API token').fill('anemo_good-token')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await panel.getByRole('button', { name: 'Settings' }).click()
  await panel.getByRole('button', { name: 'Disconnect' }).click()
  await expect(panel.getByRole('heading', { name: 'Connect to Anemo' })).toBeVisible()
  expect(anemo.tokens.has('anemo_good-token')).toBe(false)
})
