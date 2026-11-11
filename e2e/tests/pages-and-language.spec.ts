import { expect, type Page, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * Settings > Pages (where each page goes, and turning one off) and the app's language
 * (Settings > General). Both are saved on the server; the user's own choices are put
 * back afterwards.
 */

signOutAfterEach()
// The sidebar (not the phone's tab bar) is what these look at.
test.use({ viewport: { width: 1280, height: 800 } })

async function settings(page: Page) {
  return (await (await page.request.get('/api/settings')).json()) as { navigation: unknown; general: Record<string, unknown> }
}

test('move a page into the sidebar and turn another off', async ({ page }) => {
  await login(page)
  const before = (await settings(page)).navigation
  try {
    await page.request.put('/api/settings/navigation', {
      data: {
        pinned: ['home', 'notifications', 'tasks', 'calendar', 'documents', 'files'],
        more: ['projects', 'focus', 'music', 'runs', 'automations', 'agents', 'memory'],
        off: [],
      },
    })
    await page.goto('/settings/pages')
    const sidebar = page.getByRole('navigation', { name: 'Pages' })
    await expect(sidebar.getByRole('link', { name: 'Tasks' })).toBeVisible()
    await expect(sidebar.getByRole('link', { name: 'Focus' })).toHaveCount(0)

    // Focus: from "More" into the sidebar's list.
    await page.getByRole('combobox', { name: 'Where Focus goes' }).click()
    await page.getByRole('option', { name: 'Sidebar' }).click()
    await expect(sidebar.getByRole('link', { name: 'Focus' })).toBeVisible()

    // Music: off. It leaves the menus, Home and the search box, and its address leads Home.
    await page.getByRole('combobox', { name: 'Where Music goes' }).click()
    await page.getByRole('option', { name: 'Off' }).click()
    await expect(page.getByRole('region', { name: 'Off' }).getByText('Music')).toBeVisible()
    await expect.poll(async () => (await settings(page)).navigation).toMatchObject({ off: ['music'] })
    await page.getByRole('button', { name: 'More pages' }).click()
    const more = page.getByRole('navigation', { name: 'More pages' })
    await expect(more.getByRole('link', { name: 'Runs' })).toBeVisible()
    await expect(more.getByRole('link', { name: 'Music' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.goto('/music')
    await expect(page).toHaveURL(/\/home$/)
    await expect(page.locator('[data-widget="focus"]')).toBeVisible()
    await expect(page.locator('[data-widget="music"]')).toHaveCount(0)

    // The agents no longer have the music tools.
    const tools = (await (await page.request.get('/api/tools')).json()) as { name: string }[]
    expect(tools.map((t) => t.name)).not.toContain('queue_music')
    expect(tools.map((t) => t.name)).toContain('start_focus')

    // And back on.
    await page.goto('/settings/pages')
    await page.getByRole('button', { name: 'Reset' }).click()
    await expect(page.getByText('Every page is on.')).toBeVisible()
    await page.goto('/music')
    await expect(page).toHaveURL(/\/music$/)
  } finally {
    await page.request.put('/api/settings/navigation', { data: before })
  }
})

test('the app in Ukrainian and Russian', async ({ page }) => {
  await login(page)
  const before = (await settings(page)).general
  try {
    await page.request.put('/api/settings/general', { data: { ...before, language: 'en' } })
    await page.goto('/settings/general')
    await page.getByRole('combobox', { name: 'Language' }).click()
    await page.getByRole('option', { name: 'Українська' }).click()
    await page.getByRole('button', { name: 'Save' }).click()
    // The whole app is drawn again in the new language, without a reload.
    await expect(page.getByRole('button', { name: 'Новий чат' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Сторінки' }).getByRole('link', { name: 'Завдання' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'uk')

    // It is remembered: a reload shows it at once.
    await page.reload()
    await expect(page.getByRole('button', { name: 'Новий чат' })).toBeVisible()

    await page.getByRole('combobox', { name: 'Мова' }).click()
    await page.getByRole('option', { name: 'Русский' }).click()
    await page.getByRole('button', { name: 'Зберегти' }).click()
    await expect(page.getByRole('button', { name: 'Новый чат' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Страницы' }).getByRole('link', { name: 'Задачи' })).toBeVisible()
  } finally {
    await page.request.put('/api/settings/general', { data: before })
    // The browser remembers the language too; the next test starts in English.
    await page.evaluate(() => localStorage.removeItem('anemo.language'))
  }
})
