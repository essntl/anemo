import { expect, type Page, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * Home: rearranging and resizing widgets, by mouse and keyboard; the layout is saved
 * on the server. The user's own layout is put back afterwards.
 */

signOutAfterEach()

type Layout = { id: string; w: number; h: number; hidden: boolean }

async function savedLayout(page: Page): Promise<Layout[]> {
  return ((await (await page.request.get('/api/settings')).json()).home as { layout: Layout[] }).layout
}

const order = (page: Page) => page.locator('[data-widget]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.widget))

test('rearrange and resize widgets; the layout is saved', async ({ page }) => {
  await login(page)
  const before = (await (await page.request.get('/api/settings')).json()).home
  try {
    await page.request.put('/api/settings/home', { data: { layout: [] } }) // the default layout
    await page.goto('/home')
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Good (morning|afternoon|evening)/)
    await expect(page.locator('[data-widget="focus"]')).toBeVisible()
    expect((await order(page)).slice(0, 2)).toEqual(['focus', 'today'])

    // E toggles editing (which also shows widgets that hide while empty).
    await page.locator('h1').click()
    await page.keyboard.press('e')
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()
    const first = await order(page)

    // Keyboard: Today moves before Focus, then grows a column wider.
    const today = page.locator('[data-widget="today"]')
    await today.focus()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => order(page)).toEqual(['today', 'focus', ...first.slice(2)])
    await today.focus()
    await page.keyboard.press('Shift+ArrowRight')
    await expect(today).toHaveAttribute('aria-label', /Today, 2 by 2/)

    // Mouse: drag Music onto Focus (once the grid has settled after the resize).
    await page.waitForTimeout(600)
    const music = page.locator('[data-widget="music"]')
    const box = (await music.boundingBox())!
    const target = (await page.locator('[data-widget="focus"]').boundingBox())!
    await page.mouse.move(box.x + 40, box.y + 60)
    await page.mouse.down()
    await page.mouse.move(target.x + target.width / 2, target.y + 50, { steps: 12 })
    await page.waitForTimeout(400)
    await page.mouse.up()
    await expect.poll(async () => (await order(page)).indexOf('music')).toBeLessThan(first.indexOf('music'))

    // Hide one, then add it back from the tray.
    await page.getByRole('button', { name: 'Hide Upcoming' }).click()
    await expect(page.locator('[data-widget="upcoming"]')).toHaveCount(0)
    await page.getByRole('group', { name: 'Add a widget' }).getByRole('button', { name: 'Upcoming' }).click()
    await expect(page.locator('[data-widget="upcoming"]')).toBeVisible()
    await page.getByRole('button', { name: 'Done' }).click()

    // Saved on the server, in the order shown.
    const shown = await order(page)
    await expect
      .poll(async () => (await savedLayout(page)).filter((w) => !w.hidden).map((w) => w.id).filter((id) => shown.includes(id)))
      .toEqual(shown)
    expect((await savedLayout(page)).find((w) => w.id === 'today')).toMatchObject({ w: 2, h: 2 })

    // Each widget has a way to its full page.
    await page.locator('[data-widget="focus"]').getByRole('link', { name: 'Open Focus' }).click()
    await expect(page).toHaveURL(/\/focus$/)
  } finally {
    await page.request.put('/api/settings/home', { data: before })
  }
})

test('Today adds and completes a task for today; Ask Anemo starts a chat', async ({ page }) => {
  await login(page)
  await page.goto('/home')
  const title = `E2E today ${Date.now()}`
  const today = page.locator('[data-widget="today"]')
  await today.getByRole('textbox', { name: 'Add a task for today' }).fill(title)
  await today.getByRole('textbox', { name: 'Add a task for today' }).press('Enter')
  await expect(today.getByRole('link', { name: title })).toBeVisible()
  type T = { id: string; title: string; due_date: string | null; status: string }
  const task = ((await (await page.request.get('/api/tasks?status=all')).json()) as T[]).find((t) => t.title === title)!
  expect(task.due_date).not.toBeNull()
  await today.getByRole('checkbox', { name: `Complete “${title}”` }).click()
  await expect
    .poll(async () => ((await (await page.request.get('/api/tasks?status=all')).json()) as T[]).find((t) => t.id === task.id)?.status)
    .toBe('done')
  await page.request.delete(`/api/tasks/${task.id}`)

  // Ask Anemo: Enter starts a new chat with the message.
  const ask = page.locator('[data-widget="ask"]')
  await ask.getByRole('textbox', { name: 'Ask Anemo' }).fill('Hello from Home')
  await ask.getByRole('textbox', { name: 'Ask Anemo' }).press('Enter')
  await page.waitForURL(/\/c\//)
  await expect(page.getByText('Hello from Home').first()).toBeVisible()
  await page.request.delete(`/api/conversations/${page.url().split('/c/')[1]}`)
})
