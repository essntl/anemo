import { expect, type Locator, type Page, test } from '@playwright/test'
import { login, signOutAfterEach, useHomeLayout } from './helpers'

/*
 * Full width (Settings > Appearance): the switch, a page's own button, and Home's free
 * grid (move and resize by mouse and keyboard; the places are saved and survive a reload).
 *
 * The appearance is kept on this device only ("Use a different appearance on this
 * device"), so the other tests running meanwhile keep the server's (centred) layout. The
 * Home layout is the user's, so it is locked and put back afterwards.
 */

signOutAfterEach()
// Tall enough that no drag comes near the bottom edge, where the page scrolls along.
test.use({ viewport: { width: 1440, height: 1400 } })

type Saved = { id: string; grid: { x: number; y: number; w: number; h: number } | null; hidden: boolean }

const placeOf = (widget: Locator) => widget.getAttribute('data-place')

async function savedLayout(page: Page): Promise<Saved[]> {
  return ((await (await page.request.get('/api/settings')).json()).home as { layout: Saved[] }).layout
}

/** The grid's rows as laid out now: where each starts and ends, from the grid's top. */
async function rowTracks(page: Page): Promise<{ start: number; end: number }[]> {
  return page.getByTestId('widget-grid').evaluate((grid) => {
    const sizes = getComputedStyle(grid).gridTemplateRows.split(' ').map(parseFloat)
    let at = 0
    return sizes.map((size) => {
      const row = { start: at, end: at + size }
      at += size + 16
      return row
    })
  })
}

/**
 * Drags `handle` by whole cells: `cols` columns, and `rows` rows from the widget's top
 * (moving, `place` is where it is) or from its bottom (resizing). Rows grow with their
 * content, so the distance comes from the grid's real rows.
 */
async function dragBy(page: Page, handle: Locator, place: number[], cols: number, rows: number, edge: 'start' | 'end') {
  const grid = (await page.getByTestId('widget-grid').boundingBox())!
  const tracks = await rowTracks(page)
  const [, y, , h] = place
  const row = edge === 'start' ? y : y + h - 1
  const dy = tracks[row + rows][edge] - tracks[row][edge]
  const dx = (cols * (grid.width + 16)) / 12
  const box = (await handle.boundingBox())!
  const px = box.x + Math.min(box.width / 2, 40)
  const py = box.y + Math.min(box.height / 2, 40)
  await page.mouse.move(px, py)
  await page.mouse.down()
  await page.mouse.move(px + dx, py + dy, { steps: 12 })
  await page.mouse.up()
}

const parse = async (widget: Locator) => (await placeOf(widget))!.split(',').map(Number)

test('full width: the setting, a page button, and Home as a free grid', async ({ page }) => {
  await login(page)
  await useHomeLayout()
  const before = (await (await page.request.get('/api/settings')).json()).home
  try {
    // The default layout, but without "Needs you": it hides itself when empty, and what is
    // under it then moves up, which would depend on what other tests left to approve.
    const ids = ['focus', 'today', 'daily', 'music', 'needs', 'ask', 'week', 'tasks', 'upcoming', 'documents', 'board', 'briefing']
    const sizes: Record<string, [number, number]> = { focus: [1, 2], today: [1, 2], daily: [1, 2], ask: [2, 1], board: [3, 2] }
    const layout = ids.map((id) => ({ id, w: sizes[id]?.[0] ?? 1, h: sizes[id]?.[1] ?? 1, hidden: id === 'needs' || id === 'briefing' }))
    await page.request.put('/api/settings/home', { data: { layout, mobile_layout: [] } })
    await page.evaluate(() => localStorage.setItem('anemo.appearance.thisDevice', '1'))

    // Off by default: the usual slots.
    await page.goto('/home')
    const grid = page.getByTestId('widget-grid')
    await expect(page.locator('[data-widget="focus"]')).toBeVisible()
    await expect(grid).not.toHaveAttribute('data-grid', 'free')
    const slots = (await page.locator('[data-widget="focus"]').boundingBox())!

    // The switch in Settings > Appearance.
    await page.goto('/settings/appearance')
    const setting = page.getByRole('switch', { name: 'Full width' })
    await expect(setting).not.toBeChecked()
    await setting.click()
    await expect(setting).toBeChecked()

    // Home is now the free grid, laid out from the slots: nothing moved, in the same order.
    await page.goto('/home')
    await expect(grid).toHaveAttribute('data-grid', 'free')
    await expect(grid).toHaveAttribute('data-cols', '12')
    const focus = page.locator('[data-widget="focus"]')
    const music = page.locator('[data-widget="music"]')
    await expect(focus).toHaveAttribute('data-place', '0,0,4,4')
    await expect(music).toHaveAttribute('data-place', '0,4,4,2')
    expect((await focus.boundingBox())!.width).toBeGreaterThan(slots.width) // the page is wider

    // Home's own button switches just this page back, and on again.
    const toggle = page.getByRole('button', { name: 'Full width' })
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()
    await expect(grid).not.toHaveAttribute('data-grid', 'free')
    await toggle.click()
    await expect(grid).toHaveAttribute('data-grid', 'free')

    // Edit with the keyboard: focus a widget, arrows move it by a cell, Shift and arrows
    // resize it; the widgets in the way move down.
    await page.locator('h1').click()
    await page.keyboard.press('e')
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()
    await focus.focus()
    await page.keyboard.press('ArrowRight')
    await expect(focus).toHaveAttribute('aria-label', /Focus, 4 by 4, at column 2, row 1/)
    await focus.focus()
    await page.keyboard.press('Shift+ArrowDown')
    await expect(focus).toHaveAttribute('data-place', '1,0,4,5')
    const overlapsFocus = async () => {
      const [x, y, w, h] = (await placeOf(page.locator('[data-widget="today"]')))!.split(',').map(Number)
      return x < 5 && x + w > 1 && y < 5 && y + h > 0
    }
    expect(await overlapsFocus()).toBe(false) // Today moved down out of its way

    // The mouse: drag Music 5 columns right and 2 rows down; it snaps to the cells.
    const [mx, my] = await parse(music)
    await dragBy(page, music, await parse(music), 5, 2, 'start')
    const moved = `${mx + 5},${my + 2},4,2`
    await expect(music).toHaveAttribute('data-place', moved)
    for (const other of await page.locator('[data-widget]').all()) {
      if ((await other.getAttribute('data-widget')) === 'music') continue
      const [x, y, w, h] = (await placeOf(other))!.split(',').map(Number)
      expect(x < mx + 9 && x + w > mx + 5 && y < my + 4 && y + h > my + 2, `${await other.getAttribute('data-widget')} overlaps Music`).toBe(false)
    }

    // Resize it from its corner: 2 columns wider, 1 row taller.
    await dragBy(page, music.locator('[data-resize]'), await parse(music), 2, 1, 'end')
    const resized = { x: mx + 5, y: my + 2, w: 6, h: 3 }
    await expect(music).toHaveAttribute('data-place', `${resized.x},${resized.y},6,3`)
    await page.getByRole('button', { name: 'Done' }).click()

    // Saved on the server, and still there after a reload.
    await expect.poll(async () => (await savedLayout(page)).find((w) => w.id === 'music')?.grid).toEqual(resized)
    await page.reload()
    await expect(grid).toHaveAttribute('data-grid', 'free')
    await expect(music).toHaveAttribute('data-place', `${resized.x},${resized.y},6,3`)
    await expect(focus).toHaveAttribute('data-place', '1,0,4,5')

    // The other pages with a button follow the setting too.
    await page.goto('/tasks')
    await expect(page.getByRole('button', { name: 'Full width' })).toHaveAttribute('aria-pressed', 'true')
  } finally {
    await page.request.put('/api/settings/home', { data: before })
  }
})
