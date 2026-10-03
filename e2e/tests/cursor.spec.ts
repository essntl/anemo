import { expect, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * Everything you can click shows the hand cursor (Tailwind v4 gives buttons the arrow;
 * app.css puts the hand back). Read-only: it only opens pages.
 */

signOutAfterEach()

const PAGES = ['/', '/chats', '/projects', '/files', '/documents', '/tasks', '/calendar', '/runs', '/automations', '/agents', '/memory', '/settings/general']

test('every clickable element shows the hand cursor', async ({ page }) => {
  await login(page)
  for (const path of PAGES) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    const wrong = await page.evaluate(() => {
      const clickable = 'button, a[href], [role=button], [role=tab], [role=radio], [role=checkbox], [role=switch], [role=combobox], [role=menuitem], select, summary'
      return [...document.querySelectorAll<HTMLElement>(clickable)]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .filter((el) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true')
        .filter((el) => getComputedStyle(el).cursor !== 'pointer')
        .map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 40))
    })
    expect(wrong, `on ${path}`).toEqual([])
  }
})
