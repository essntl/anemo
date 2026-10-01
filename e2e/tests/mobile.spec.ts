import { expect, type Page, test } from '@playwright/test'
import { answerPrompt, confirmWith, fakeModels, login, pickModel, signOutAfterEach } from './helpers'

/*
 * Phone layout and installable-app checks. Runs in the "mobile" project
 * (Pixel 7 viewport with touch; see playwright.config.ts).
 */

signOutAfterEach()

const SCREENS = [
  '/',
  '/files',
  '/runs',
  '/runs?kind=all',
  '/agents',
  '/agents?tab=skills',
  '/settings',
  '/settings/general',
  '/settings/appearance',
  '/settings/providers',
  '/settings/permissions',
  '/settings/workspace',
  '/settings/web',
]

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
}

test('no screen scrolls sideways on a phone', async ({ page }) => {
  await login(page)
  for (const url of SCREENS) {
    await page.goto(url)
    await page.waitForLoadState('networkidle')
    expect(await horizontalOverflow(page), `${url} is wider than the screen`).toBeLessThanOrEqual(0)
  }
})

test('the menu drawer opens, navigates and closes', async ({ page }) => {
  await login(page)
  // The desktop sidebar is hidden; the drawer holds the navigation.
  await expect(page.getByRole('link', { name: 'Files', exact: true })).toBeHidden()
  await page.getByRole('button', { name: 'Open menu' }).click()
  const drawer = page.getByRole('dialog', { name: 'Menu' })
  await expect(drawer).toBeVisible()
  await drawer.getByRole('link', { name: 'Files', exact: true }).click()
  await expect(page).toHaveURL(/\/files/)
  await expect(drawer).toBeHidden()

  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'Close menu' }).click()
  await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden()
})

test('settings is a list of sections with a way back', async ({ page }) => {
  await login(page)
  await page.goto('/settings')
  await page.getByRole('link', { name: 'Appearance' }).click()
  await expect(page).toHaveURL(/\/settings\/appearance/)
  await expect(page.getByText('Accent color')).toBeVisible()
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('link', { name: 'Providers & Models' })).toBeVisible()
})

test('files: open a file full screen, go back, and use the row menu', async ({ page }) => {
  await login(page)
  const folder = `e2e-m-${Date.now()}`
  try {
    await page.goto('/files')
    await page.getByRole('button', { name: 'Folder', exact: true }).click()
    await answerPrompt(page, folder)
    await page.getByRole('button', { name: folder, exact: true }).click()
    await page.getByRole('button', { name: 'File', exact: true }).click()
    await answerPrompt(page, 'note.md')
    // The editor takes the whole screen; the list is hidden until you go back.
    await expect(page.locator('.cm-content')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Upload' })).toBeHidden()
    await page.getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('button', { name: 'note.md', exact: true })).toBeVisible()

    // Touch screens have no hover, so row actions live in a "⋯" menu.
    await page.getByRole('button', { name: 'Actions for note.md' }).click()
    await page.getByRole('button', { name: 'Move to trash' }).click()
    await confirmWith(page, 'Move to trash')
    await expect(page.getByRole('button', { name: 'note.md', exact: true })).toHaveCount(0)
  } finally {
    await page.request.post('/api/files/trash', { data: { path: folder } })
    const trash = (await (await page.request.get('/api/files/trash')).json()) as { id: string; original_path: string }[]
    for (const item of trash.filter((t) => t.original_path.startsWith(folder))) {
      await page.request.delete(`/api/files/trash/${item.id}`)
    }
  }
})

test('chat on a phone: send with the button, Enter adds a new line', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  await page.getByRole('radio', { name: 'Chat' }).click()
  await pickModel(page, models.echo)
  const box = page.getByPlaceholder('Message the assistant…')
  await box.fill('first line')
  await box.press('Enter')
  await box.pressSequentially('second line')
  await expect(box).toHaveValue('first line\nsecond line')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(/You said: first line/)).toBeVisible()
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
})

test('installable: manifest, icons and a service worker that never caches /api', async ({ page, context }) => {
  const manifest = await page.request.get('/manifest.webmanifest')
  expect(manifest.ok()).toBeTruthy()
  expect(manifest.headers()['content-type']).toContain('application/manifest+json')
  const data = (await manifest.json()) as { display: string; icons: { src: string; purpose?: string }[] }
  expect(data.display).toBe('standalone')
  expect(data.icons.some((i) => i.purpose === 'maskable')).toBeTruthy()
  for (const icon of data.icons) expect((await page.request.get(icon.src)).ok()).toBeTruthy()
  expect((await page.request.get('/sw.js')).headers()['cache-control']).toBe('no-cache')

  await login(page)
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload() // now controlled by the service worker
  await expect(page.getByRole('radiogroup', { name: 'Mode' })).toBeVisible()
  await page.goto('/settings/general')
  await page.waitForLoadState('networkidle')
  const cached = await page.evaluate(async () => {
    const urls: string[] = []
    for (const key of await caches.keys()) {
      for (const request of await (await caches.open(key)).keys()) urls.push(new URL(request.url).pathname)
    }
    return urls
  })
  expect(cached.length).toBeGreaterThan(0)
  expect(cached.filter((u) => u.startsWith('/api/'))).toEqual([])

  // Server unreachable: a friendly offline page instead of the browser's error.
  await context.setOffline(true)
  try {
    await page.goto('/files').catch(() => undefined)
    await expect(page.getByRole('heading', { name: "Can't reach anemo" })).toBeVisible()
  } finally {
    await context.setOffline(false)
  }
})
