import { expect, test } from '@playwright/test'
import { fakeModels, login, pickModel, send, signOutAfterEach } from './helpers'

/*
 * Temporary chats. That one is really deleted after five quiet minutes is checked in
 * the backend tests (the clock is moved there); here: starting one, how it shows, and
 * keeping it. The chats made here are deleted afterwards.
 */

signOutAfterEach()

test('a temporary chat is marked as such, counts down, and can be kept', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request) // skips without the fake provider
  const mark = Math.random().toString(36).slice(2, 8)
  try {
    await page.goto('/')
    const toggle = page.getByRole('button', { name: 'Temporary chat' })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('heading', { name: 'Temporary chat' })).toBeVisible()
    await pickModel(page, models.echo)
    await send(page, `a passing thought ${mark}`)
    await expect(page).toHaveURL(/\/c\//)
    await expect(page.getByText(`You said: a passing thought ${mark}`)).toBeVisible()
    // The last words show a moment before the answer counts as finished (until then the
    // card rightly says "5 minutes after the answer"): wait for that.
    const id = page.url().split('/c/')[1]
    await expect.poll(async () => ((await (await page.request.get(`/api/conversations/${id}`)).json()) as { active_run_id: string | null }).active_run_id).toBeNull()

    // A label beside the chat's name shows the time left; pointing at it says what it
    // means. The sidebar lists the chat under "Temporary".
    const label = page.getByRole('button', { name: /^Temporary chat, [45]:\d\d left$/ })
    await expect(label).toBeVisible()
    await label.hover()
    const card = page.getByRole('dialog').filter({ hasText: 'Temporary chat' })
    await expect(card).toContainText(/deleted in [45]:\d\d \(5 minutes after the last message\) unless you keep it/)
    // A click while the mouse opened it keeps it open.
    await label.click()
    await expect(card).toBeVisible()
    const sidebar = page.locator('aside').first()
    const temporaryGroup = sidebar.locator('section', { has: page.getByText('Temporary', { exact: true }) })
    await expect(temporaryGroup.getByRole('link')).toHaveCount(1)
    await expect(temporaryGroup.getByRole('link')).toContainText(/[45]m$/)
    const chat = await (await page.request.get(`/api/conversations/${page.url().split('/c/')[1]}`)).json() as { temporary: boolean }
    expect(chat.temporary).toBe(true)

    // Keeping it: the label goes, and it becomes an ordinary chat of today.
    await card.getByRole('button', { name: 'Keep chat' }).click()
    await expect(label).toHaveCount(0)
    await expect(sidebar.getByText('Temporary', { exact: true })).toHaveCount(0)
    const kept = await (await page.request.get(`/api/conversations/${page.url().split('/c/')[1]}`)).json() as { temporary: boolean }
    expect(kept.temporary).toBe(false)
  } finally {
    const id = page.url().split('/c/')[1]
    if (id) await page.request.delete(`/api/conversations/${id}`)
  }
})

test('on a touch screen a tap opens the explanation and it stays open', async ({ browser, page }) => {
  await login(page)
  const models = await fakeModels(page.request) // skips without the fake provider
  const conv = (await (await page.request.post('/api/conversations', { data: { model_id: models.echo, temporary: true } })).json()) as { id: string }
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true })
  try {
    const p = await phone.newPage()
    await p.goto(new URL(`/c/${conv.id}`, page.url()).toString())
    const label = p.getByRole('button', { name: /^Temporary chat, / })
    const card = p.getByRole('dialog').filter({ hasText: 'Keep chat' })

    // A real tap.
    await label.tap()
    await expect(card).toBeVisible()
    await p.waitForTimeout(600)
    await expect(card).toBeVisible()
    await label.tap() // a second tap closes it
    await expect(card).toHaveCount(0)
  } finally {
    await phone.close()
    await page.request.delete(`/api/conversations/${conv.id}`)
  }
})
