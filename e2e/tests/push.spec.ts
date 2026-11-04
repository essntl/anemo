import { expect, request as playwrightRequest, test } from '@playwright/test'
import { confirmWith, login, signOutAfterEach } from './helpers'

/*
 * Push notifications in a real browser, as far as a headless browser allows: it has
 * no real push service, so the device here is registered through the API with a
 * made-up subscription that receives no kind of notification (so nothing is ever
 * sent anywhere), and is removed again.
 */

signOutAfterEach()

const suffix = () => Math.random().toString(36).slice(2, 8)

const b64url = (bytes: ArrayBuffer) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A subscription like PushManager.subscribe() gives, with a real P-256 key. */
async function fakeSubscription(name: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
  return {
    endpoint: `https://push.invalid/e2e/${suffix()}`,
    keys: { p256dh: b64url(raw), auth: b64url(crypto.getRandomValues(new Uint8Array(16)).buffer) },
    name,
    kinds: [], // receives nothing: the address does not exist
  }
}

test('push: the settings card, a device in the list, and removing it', async ({ page }) => {
  const name = `E2E device ${suffix()}`
  await login(page)

  const key = (await (await page.request.get('/api/push/key')).json()) as { public_key: string }
  expect(Buffer.from(key.public_key, 'base64url')).toHaveLength(65)

  const created = await page.request.post('/api/push/subscriptions', { data: await fakeSubscription(name) })
  expect(created.ok()).toBeTruthy()
  const device = (await created.json()) as { id: string; type: string; push_service: string; kinds: string[] }
  expect(device).toMatchObject({ type: 'webpush', push_service: 'push.invalid', kinds: [] })
  try {
    await page.goto('/settings/notifications')
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible()
    await expect(page.getByText('Push notifications', { exact: true })).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Push notifications on this device' })).toBeVisible()
    // The Discord card keeps its own Add button; devices are not listed there.
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(1)

    const row = page.locator('div.rounded-control', { hasText: name })
    await expect(row).toBeVisible()
    await expect(row.getByText('Push', { exact: true })).toBeVisible()
    await expect(row.getByText('This device')).toHaveCount(0) // registered by the API, not this browser

    // Editing a device has no webhook field.
    await row.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Name')).toHaveValue(name)
    await expect(dialog.getByLabel('Webhook URL')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)

    await row.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await confirmWith(page, 'Remove')
    await expect(row).toHaveCount(0)
  } finally {
    await page.request.delete(`/api/notification-destinations/${device.id}`)
  }
})

test('push: approval buttons need their token and nothing else works', async ({ baseURL }) => {
  // No session at all, like the service worker after the login expired.
  const anonymous = await playwrightRequest.newContext({ baseURL })
  try {
    const unknown = await anonymous.post('/api/public/push/actions', { data: { token: 'x'.repeat(43) } })
    expect(unknown.status()).toBe(404)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('push_action_gone')
    expect(unknown.headers()['cache-control']).toBe('no-store')

    const malformed = await anonymous.post('/api/public/push/actions', { data: { token: 'short' } })
    expect(malformed.status()).toBe(422)

    // Everything else about push needs a session.
    expect((await anonymous.get('/api/push/key')).status()).toBe(401)
    const subscribe = await anonymous.post('/api/push/subscriptions', { data: await fakeSubscription('nobody') })
    expect(subscribe.status()).toBe(401)
  } finally {
    await anonymous.dispose()
  }
})
