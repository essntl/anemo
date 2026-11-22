import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { PASSWORD, USERNAME, answerPrompt, confirmWith, login, signOutAfterEach } from './helpers'

/*
 * Settings → Devices (docs/specs/06-desktop-client.md): adding a computer or a phone, its
 * token shown once, renaming, the trust level behind the password, deleting. Every device
 * a test adds is deleted again, also when the test fails.
 */

signOutAfterEach()

type Device = { id: string; name: string; kind: string; trust: string }

const suffix = () => Date.now().toString(36)

async function listDevices(request: APIRequestContext): Promise<Device[]> {
  return (await (await request.get('/api/devices')).json()) as Device[]
}

async function deleteNamed(request: APIRequestContext, ...names: string[]) {
  for (const d of await listDevices(request)) {
    if (names.includes(d.name)) await request.delete(`/api/devices/${d.id}`)
  }
}

async function addInUi(page: Page, name: string, kind: 'Computer' | 'Phone') {
  await page.goto('/settings/devices')
  await page.getByRole('textbox', { name: 'Name' }).fill(name)
  await page.getByRole('radiogroup', { name: 'Kind' }).getByRole('radio', { name: kind }).click()
  await page.getByRole('button', { name: 'Add device' }).click()
  const token = page.getByTestId('new-device-token')
  await expect(token).toHaveText(/^anemo_\S+$/)
  return (await token.textContent())!.trim()
}

/**
 * The session's own password confirmation (made at login) is still fresh in a test, so
 * the server's first answer to a trust change is made to ask for the password, as it does
 * fifteen minutes after the password was last given. The retry goes to the server.
 */
async function askForThePasswordOnce(page: Page) {
  let asked = false
  await page.route('**/api/devices/*/trust', async (route) => {
    if (asked) return route.fallback()
    asked = true
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'reauth_required', message: 'Confirm your password', details: null } }),
    })
  })
}

test('a computer is added with its token shown once, renamed, made trusted with the password, and deleted', async ({
  page,
  playwright,
}) => {
  await login(page)
  const name = `E2E PC ${suffix()}`
  const renamed = `${name} renamed`
  // A client that has only the token, as Anemo Desktop does.
  let device: APIRequestContext | undefined
  const asDevice = (token: string) =>
    playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } })
  try {
    await page.goto('/settings/devices')
    // A computer is watched unless chosen otherwise.
    await expect(page.getByRole('radiogroup', { name: 'Trust' }).getByRole('radio', { name: 'Watched' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    const token = await addInUi(page, name, 'Computer')
    const added = page.getByRole('status').filter({ hasText: 'it is shown only this once' })
    await expect(added).toContainText('Paste it into Anemo Desktop on that computer')
    const row = page.getByTestId('device-row').filter({ hasText: name })
    await expect(row).toContainText('Offline')
    await expect(row).toContainText('never connected')
    await expect(row.getByRole('combobox', { name: `Trust of “${name}”` })).toHaveText('Watched')

    // The token is a login for the REST API.
    device = await asDevice(token)
    expect((await device.get('/api/devices')).status()).toBe(200)

    // Done hides it, and it is never shown again: not after a reload either.
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByTestId('new-device-token')).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('device-row').filter({ hasText: name })).toBeVisible()
    await expect(page.getByTestId('new-device-token')).toHaveCount(0)
    expect(await page.content()).not.toContain(token)

    // Rename.
    await page.getByTestId('device-row').filter({ hasText: name }).getByRole('button', { name: 'Rename' }).click()
    await answerPrompt(page, renamed)
    const renamedRow = page.getByTestId('device-row').filter({ hasText: renamed })
    await expect(renamedRow).toBeVisible()

    // The trust level needs the password again.
    await askForThePasswordOnce(page)
    await renamedRow.getByRole('combobox', { name: `Trust of “${renamed}”` }).click()
    await page.getByRole('option', { name: 'Trusted' }).click()
    const dialog = page.getByRole('dialog', { name: "Confirm it's you" })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Password').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Confirm' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(renamedRow.getByRole('combobox', { name: `Trust of “${renamed}”` })).toHaveText('Trusted')
    await page.unroute('**/api/devices/*/trust')
    await page.reload()
    await expect(page.getByRole('combobox', { name: `Trust of “${renamed}”` })).toHaveText('Trusted')
    expect((await listDevices(page.request)).find((d) => d.name === renamed)?.trust).toBe('trusted')

    // The device's own token can't change its trust level.
    const id = (await listDevices(page.request)).find((d) => d.name === renamed)!.id
    expect((await device.put(`/api/devices/${id}/trust`, { data: { trust: 'watched' } })).status()).toBe(403)

    // Delete: gone from the list, and its token stops working.
    await page.getByTestId('device-row').filter({ hasText: renamed }).getByRole('button', { name: 'Delete' }).click()
    await confirmWith(page, 'Delete')
    await expect(page.getByTestId('device-row').filter({ hasText: renamed })).toHaveCount(0)
    expect((await device.get('/api/devices')).status()).toBe(401)
  } finally {
    await device?.dispose()
    await deleteNamed(page.request, name, renamed)
  }
})

test('a phone has no trust level to choose', async ({ page }) => {
  await login(page)
  const name = `E2E Phone ${suffix()}`
  try {
    await page.goto('/settings/devices')
    await page.getByRole('radiogroup', { name: 'Kind' }).getByRole('radio', { name: 'Phone' }).click()
    await expect(page.getByRole('radiogroup', { name: 'Trust' })).toHaveCount(0)
    await addInUi(page, name, 'Phone')
    await expect(page.getByRole('status').filter({ hasText: 'it is shown only this once' })).toContainText(
      'Paste it into Anemo Voice on that phone',
    )
    await page.getByRole('button', { name: 'Done' }).click()
    const row = page.getByTestId('device-row').filter({ hasText: name })
    await expect(row).toContainText('Phone')
    await expect(row.getByRole('combobox')).toHaveCount(0)
    await expect(row.getByRole('button', { name: 'Rename' })).toBeVisible()
    expect((await listDevices(page.request)).find((d) => d.name === name)?.trust).toBe('watched')
  } finally {
    await deleteNamed(page.request, name)
  }
})

// Fails today: the server answers a wrong password with 401 (`wrong_password`), and the
// app treats any 401 as "the session is gone" (frontend/src/api/client.ts, unwrap) and
// shows the login page instead of saying "Wrong password" in the dialog. Not part of the
// devices work; reported. Remove `test.fail` once it is fixed. It is called just before
// the last check, so everything before it still fails the test as usual.
test('a wrong password in the password dialog is said there', async ({ page }) => {
  await login(page)
  const name = `E2E PC ${suffix()}`
  try {
    await addInUi(page, name, 'Computer')
    await page.getByRole('button', { name: 'Done' }).click()
    await askForThePasswordOnce(page)
    await page.getByRole('combobox', { name: `Trust of “${name}”` }).click()
    await page.getByRole('option', { name: 'Trusted' }).click()
    const dialog = page.getByRole('dialog', { name: "Confirm it's you" })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Password').fill('not the password')
    await dialog.getByRole('button', { name: 'Confirm' }).click()
    test.fail(true, 'a wrong password in the re-authentication dialog signs the user out')
    await expect(dialog).toContainText('Wrong password', { timeout: 5000 })
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0)
  } finally {
    await page.request.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } })
    await deleteNamed(page.request, name)
  }
})
