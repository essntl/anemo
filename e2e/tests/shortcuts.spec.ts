import { expect, type Page, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * The keyboard shortcut sheet: ? opens it (not while typing), the page you are on is
 * listed first, Esc closes it, and the search box and Settings open it too. Nothing is
 * created or changed.
 */

signOutAfterEach()

const sheet = (page: Page) => page.getByRole('dialog', { name: 'Keyboard shortcuts' })
const areas = (page: Page) => sheet(page).locator('section[data-area]')
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

test('? shows the shortcuts with this page first, Esc closes them', async ({ page }) => {
  await login(page)
  await page.goto('/focus')
  await expect(page.getByRole('button', { name: 'Start timer' })).toBeVisible()
  await blur(page) // nothing focused that takes text
  await page.keyboard.press('?')
  await expect(sheet(page)).toBeVisible()
  await expect(areas(page).first()).toHaveAttribute('data-area', 'focus')
  await expect(areas(page).nth(1)).toHaveAttribute('data-area', 'everywhere')
  await expect(sheet(page).getByText('Start or pause the timer', { exact: true })).toBeVisible()
  await expect(sheet(page).getByText('Search everything, open a page or run an action', { exact: true })).toBeVisible()
  // The keys of a shortcut with Ctrl (⌘ on a Mac).
  const search = sheet(page).locator('li').filter({ hasText: 'Search everything' })
  await expect(search.locator('kbd')).toHaveText([/^(Ctrl|⌘)$/, 'K'])
  await page.keyboard.press('Escape')
  await expect(sheet(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start timer' })).toBeVisible()

  // Elsewhere, Everywhere comes first.
  await page.goto('/calendar')
  await expect(page.locator('#main-column h1')).toBeVisible() // the app is up and listening
  await blur(page)
  await page.keyboard.press('?')
  await expect(areas(page).first()).toHaveAttribute('data-area', 'everywhere')
  await page.keyboard.press('Escape')
  await expect(sheet(page)).toHaveCount(0)
})

test('? is just a character while typing', async ({ page }) => {
  await login(page)
  await page.goto('/tasks')
  const box = page.getByRole('textbox', { name: 'Add a task', exact: true })
  await box.click()
  await page.keyboard.type('Why?')
  await expect(box).toHaveValue('Why?')
  await expect(sheet(page)).toHaveCount(0)
  await box.fill('')
})

test('the search box and Settings open the sheet too', async ({ page }) => {
  await login(page)
  await page.keyboard.press('Control+k')
  const box = page.getByRole('combobox', { name: 'Search' })
  await box.fill('keyboard shortcuts')
  await expect(page.getByRole('option', { name: /Keyboard shortcuts/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(sheet(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet(page)).toHaveCount(0)

  await page.goto('/settings/general')
  await page.getByRole('button', { name: 'Show keyboard shortcuts', exact: true }).click()
  await expect(sheet(page)).toBeVisible()
  await expect(areas(page).first()).toHaveAttribute('data-area', 'everywhere')
  await sheet(page).getByRole('button', { name: 'Close', exact: true }).click()
  await expect(sheet(page)).toHaveCount(0)
})
