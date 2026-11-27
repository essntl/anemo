import { expect, type Page, test } from '@playwright/test'
import { login, signOutAfterEach, useHomeLayout } from './helpers'

/*
 * Home: rearranging and resizing widgets, by mouse and keyboard; the layout is saved
 * on the server. The user's own layout is put back afterwards.
 *
 * The task board's test is here too, not in a file of its own: it changes the Home
 * layout as well, and the tests of one file run one after the other.
 */

signOutAfterEach()

type Layout = { id: string; w: number; h: number; hidden: boolean }

async function savedLayout(page: Page): Promise<Layout[]> {
  return ((await (await page.request.get('/api/settings')).json()).home as { layout: Layout[] }).layout
}

const order = (page: Page) => page.locator('[data-widget]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.widget))

test('rearrange and resize widgets; the layout is saved', async ({ page }) => {
  await login(page)
  await useHomeLayout()
  const before = (await (await page.request.get('/api/settings')).json()).home
  try {
    await page.request.put('/api/settings/home', { data: { layout: [] } }) // the default layout
    await page.goto('/home')
    await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ })).toBeVisible()
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

    // Mouse: drag Music onto Focus, once the grid has stopped moving after the resize.
    const music = page.locator('[data-widget="music"]')
    const focus = page.locator('[data-widget="focus"]')
    let last = ''
    await expect
      .poll(async () => {
        const now = JSON.stringify([await music.boundingBox(), await focus.boundingBox()])
        const still = now === last
        last = now
        return still
      }, { intervals: [250] })
      .toBe(true)
    const box = (await music.boundingBox())!
    const target = (await focus.boundingBox())!
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
  await useHomeLayout()
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

/*
 * The task board: moving cards between statuses with the keyboard and the mouse,
 * reordering a column, and opening a task. The tasks have a tag of their own and the
 * board is filtered to it, so tasks of a real install are not touched; they are deleted
 * again, and the user's Home layout is put back, also when the test fails.
 */
type ApiTask = { id: string; title: string; status: string; sort_order: number; tags: string[] }

async function ours(page: Page, tag: string): Promise<ApiTask[]> {
  return ((await (await page.request.get('/api/tasks?status=all')).json()) as ApiTask[]).filter((t) => t.tags.includes(tag))
}
const statusOf = async (page: Page, tag: string, title: string) => (await ours(page, tag)).find((t) => t.title === title)?.status

test('move, reorder and open tasks on the Home board', async ({ page }) => {
  const tag = `e2eboard${Math.random().toString(36).slice(2, 8)}`
  const [first, second, third] = ['Paint the hall', 'Fix the tap', 'Call the plumber'].map((t) => `E2E ${t} ${tag}`)
  await login(page)
  await useHomeLayout()
  const before = (await (await page.request.get('/api/settings')).json()).home
  try {
    for (const title of [first, second, third]) {
      await page.request.post('/api/tasks', { data: { title, description: '', status: 'todo', priority: 0, tags: [tag], checklist: [], blocked_by: [] } })
    }
    // The board first on Home, filtered to this test's tag.
    await page.request.put('/api/settings/home', {
      data: { layout: [{ id: 'board', w: 3, h: 2, options: { project: '', tag } }], mobile_layout: [] },
    })
    await page.goto('/home')
    const board = page.locator('[data-widget="board"]')
    const card = (title: string) => board.locator('[data-board-card]').filter({ hasText: title })
    const column = (status: string) => board.locator(`[data-board-column="${status}"]`)
    await expect(card(first)).toBeVisible()
    await expect(column('todo').locator('[data-board-card]')).toHaveCount(3)

    // Keyboard: Space picks the card up, → moves it to In progress, Space puts it down.
    await card(first).focus()
    await page.keyboard.press('Space')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Space')
    await expect(column('in_progress').getByText(first)).toBeVisible()
    await expect.poll(() => statusOf(page, tag, first)).toBe('in_progress')
    await expect(page.locator('[aria-live]').filter({ hasText: 'moved to In progress' })).toHaveCount(1)

    // Mouse: drag a card onto the Waiting column.
    const from = (await card(second).boundingBox())!
    const to = (await column('waiting').boundingBox())!
    await page.mouse.move(from.x + 30, from.y + 12)
    await page.mouse.down()
    await page.mouse.move(from.x + 50, from.y + 20, { steps: 3 })
    await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 12 })
    await page.mouse.up()
    await expect(column('waiting').getByText(second)).toBeVisible()
    await expect.poll(() => statusOf(page, tag, second)).toBe('waiting')

    // Reorder: in To do only "Call the plumber" is left; move "Fix the tap" back above it.
    await card(second).focus()
    await page.keyboard.press('Space')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Space')
    await expect.poll(async () => {
      const todo = (await ours(page, tag)).filter((t) => t.status === 'todo').sort((a, b) => a.sort_order - b.sort_order)
      return todo.map((t) => t.title)
    }).toEqual([second, third])
    await expect(column('todo').locator('[data-board-card]').first()).toContainText(second)

    // A click opens the task in its editor, right on Home.
    await card(third).click()
    const dialog = page.getByRole('dialog', { name: 'Task', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue(third)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // The filter it was left with is kept with the widget.
    const saved = (await (await page.request.get('/api/settings')).json()).home.layout as { id: string; options: Record<string, string | null> }[]
    expect(saved.find((w) => w.id === 'board')?.options).toMatchObject({ tag })
  } finally {
    for (const t of await ours(page, tag)) await page.request.delete(`/api/tasks/${t.id}`)
    await page.request.put('/api/settings/home', { data: before })
  }
})
