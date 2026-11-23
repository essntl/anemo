import { expect, test } from '@playwright/test'
import { login, recordAnimations, signOutAfterEach } from './helpers'

/*
 * Things animate out the way they came in, and pages cross-fade. These check that
 * the animations really run, not how they look. Nothing is created or changed.
 */

signOutAfterEach()

test('dialogs, dropdowns and the search palette animate when they close', async ({ page }) => {
  const seen = await recordAnimations(page)
  await login(page)
  await page.goto('/tasks')

  // A dialog that only exists while it is open ("New task").
  await page.getByRole('button', { name: 'New task' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  // "Visible" is about the page's layout; the opening animation starts with the next frame
  // the browser draws. Closing before that frame would skip it, so wait for it.
  await expect.poll(seen).toEqual(expect.arrayContaining(['pop-in', 'fade-in']))
  expect(await seen()).not.toContain('pop-out')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await seen()).toEqual(expect.arrayContaining(['pop-in', 'fade-in', 'pop-out', 'fade-out']))

  const count = async (name: string) => (await seen()).filter((n) => n === name).length
  const closings = () => count('pop-out')
  const afterDialog = await closings()
  // A dropdown: the project filter on All chats (reached within the app, so the record stays).
  await page.getByRole('link', { name: 'All chats' }).click()
  await expect(page).toHaveURL(/\/chats/)
  let openings = await count('pop-in')
  await page.getByRole('combobox', { name: 'Project' }).click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await expect.poll(() => count('pop-in')).toBe(openings + 1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  expect(await closings()).toBe(afterDialog + 1)

  openings = await count('pop-in')
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible()
  await expect.poll(() => count('pop-in')).toBe(openings + 1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await closings()).toBe(afterDialog + 2)
})

test('going to another page cross-fades; changing a tab on the same page does not', async ({ page }) => {
  // Count the view transitions the app starts.
  await page.addInitScript(() => {
    const counter = window as unknown as { transitions: number }
    counter.transitions = 0
    const start = document.startViewTransition.bind(document)
    document.startViewTransition = ((update: never) => {
      counter.transitions += 1
      return start(update)
    }) as typeof document.startViewTransition
  })
  const transitions = () => page.evaluate(() => (window as unknown as { transitions: number }).transitions)
  await login(page)
  // The first page of a session may redirect to Home (with its own transition): wait
  // until nothing more starts.
  let last = -1
  await expect
    .poll(async () => {
      const now = await transitions()
      const settled = now === last
      last = now
      return settled
    }, { intervals: [300] })
    .toBe(true)
  const before = await transitions()

  await page.getByRole('link', { name: 'Tasks', exact: true }).click()
  await expect(page).toHaveURL(/\/tasks/)
  expect(await transitions()).toBe(before + 1)

  await page.getByRole('radio', { name: 'Board' }).click()
  await expect(page).toHaveURL(/view=board/)
  expect(await transitions()).toBe(before + 1)
})
