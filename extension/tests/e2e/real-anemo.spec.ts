/**
 * Against a real Anemo, when one is given (skipped otherwise):
 *   ANEMO_E2E_URL=http://127.0.0.1:8099 ANEMO_E2E_TOKEN=anemo_… npm run e2e
 * The URL must be on 127.0.0.1 (the test build may reach only that without a prompt).
 * Use a throwaway install: the tests create chats in it.
 */
import { expect, test } from './fixtures'

const url = process.env.ANEMO_E2E_URL
const token = process.env.ANEMO_E2E_TOKEN

test.skip(!url || !token, 'set ANEMO_E2E_URL and ANEMO_E2E_TOKEN to run against a real Anemo')

test('connects to a real Anemo with a token (Bearer auth and the Origin check)', async ({ panel }) => {
  await panel.getByLabel('Anemo address').fill(url!)
  await panel.getByLabel('API token').fill(token!)
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
})

test('a wrong token gets Anemo’s 401 and the right message', async ({ panel }) => {
  await panel.getByLabel('Anemo address').fill(url!)
  await panel.getByLabel('API token').fill('anemo_definitely-not-valid')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('The token doesn’t work')).toBeVisible()
})
