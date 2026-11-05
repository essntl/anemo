import { expect, test } from '@playwright/test'
import { fakeModels, login, newChat, send, signOutAfterEach } from './helpers'

/*
 * Diagrams, charts and math in a real browser: the echo model repeats a message with a
 * ```mermaid and a ```chart block and a formula, and the answer shows them drawn; a
 * diagram that can't be drawn offers "Fix diagram". A document shows the same blocks
 * drawn in the editor and keeps their text. Everything created is removed again.
 */

signOutAfterEach()

const MERMAID = '```mermaid\nflowchart LR\n  A[Plan] --> B[Build]\n  B --> C[Ship]\n```'
const CHART =
  '```chart\n{"type": "bar", "title": "Hours", "unit": "h", "x": ["Mon", "Tue", "Wed"], "series": [{"name": "Focus", "values": [2, 3, 1]}]}\n```'

test('an answer shows a diagram, a chart and math drawn', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  let conversationId = ''
  try {
    await newChat(page, 'Chat', models.echo)
    await send(page, `Here:\n\n${MERMAID}\n\n${CHART}\n\nArea is $\\pi r^2$, and it costs $5 and $10.`)
    await expect(page).toHaveURL(/\/c\//)
    conversationId = page.url().split('/c/')[1]

    const diagram = page.locator('[data-diagram="mermaid"]')
    await expect(diagram.getByRole('figure').locator('svg').first()).toBeVisible({ timeout: 15_000 })
    await expect(diagram.getByRole('figure').locator('svg').first()).toContainText('Build')
    await expect(diagram.getByRole('alert')).toHaveCount(0)

    const chart = page.locator('[data-diagram="chart"]')
    await expect(chart.getByRole('img', { name: /Hours/ })).toBeVisible()
    await expect(page.locator('.katex').first()).toBeVisible()
    await expect(page.locator('.markdown').getByText('it costs $5 and $10.')).toBeVisible()

    // Source and back.
    await diagram.getByRole('button', { name: 'Source' }).click()
    await expect(diagram.getByText('A[Plan] --> B[Build]')).toBeVisible()
    await diagram.getByRole('button', { name: 'Diagram', exact: true }).click()
    await expect(diagram.getByRole('figure').locator('svg').first()).toBeVisible()

    // Downloads, named after the chart's title.
    const svgDownload = page.waitForEvent('download')
    await diagram.getByRole('button', { name: 'Download as SVG' }).click()
    expect((await svgDownload).suggestedFilename()).toBe('diagram.svg')
    const pngDownload = page.waitForEvent('download')
    await chart.getByRole('button', { name: 'Download as PNG' }).click()
    expect((await pngDownload).suggestedFilename()).toBe('hours.png')

    // Full screen, with zoom.
    await chart.getByRole('button', { name: 'Full screen' }).click()
    const viewer = page.getByRole('dialog', { name: 'Hours' })
    await expect(viewer.getByRole('img', { name: /Hours/ })).toBeVisible()
    await viewer.getByRole('button', { name: 'Zoom in' }).click()
    await expect(viewer.getByText('125%')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)

    // A diagram that can't be drawn: its source, the error, and Fix diagram.
    await send(page, 'Broken:\n\n```mermaid\nflowchart LR\n  A[Start --> B\n```')
    const broken = page.locator('[data-diagram="mermaid"]').nth(1)
    await expect(broken.getByRole('alert')).toContainText('This diagram can’t be drawn.', { timeout: 15_000 })
    await expect(broken.locator('pre')).toContainText('A[Start --> B')
    await broken.getByRole('button', { name: 'Fix diagram' }).click()
    await expect(page.getByText(/You said: The Mermaid diagram in your answer can't be drawn/)).toBeVisible()
  } finally {
    if (conversationId) await page.request.delete(`/api/conversations/${conversationId}`).catch(() => undefined)
  }
})

test('a document shows its diagrams drawn and keeps their text', async ({ page }) => {
  await login(page)
  const title = `E2E diagrams ${Math.random().toString(36).slice(2, 8)}`
  const content = `# ${title}\n\n${MERMAID}\n\n${CHART}\n`
  const created = await page.request.post('/api/documents', { data: { title, content } })
  expect(created.ok()).toBe(true)
  const doc = (await created.json()) as { id: string; path: string }
  try {
    await page.goto(`/documents/${doc.id}`)
    const editor = page.getByLabel('Document text')
    const diagram = editor.locator('[data-diagram="mermaid"]')
    await expect(diagram.getByRole('figure').locator('svg').first()).toBeVisible({ timeout: 15_000 })
    await expect(diagram.getByRole('figure').locator('svg').first()).toContainText('Ship')
    await expect(editor.locator('[data-diagram="chart"]').getByRole('img', { name: /Hours/ })).toBeVisible()
    // The source is hidden until Edit.
    await expect(editor.getByText('flowchart LR')).toBeHidden()
    await diagram.getByRole('button', { name: 'Edit' }).click()
    await expect(editor.getByText('flowchart LR')).toBeVisible()
    await diagram.getByRole('button', { name: 'Done' }).click()
    await expect(editor.getByText('flowchart LR')).toBeHidden()

    // Looking at it changed nothing in the file.
    const saved = (await (await page.request.get(`/api/documents/${doc.id}`)).json()) as { content: string }
    expect(saved.content).toBe(content)
  } finally {
    await page.request.delete(`/api/documents/${doc.id}`).catch(() => undefined)
    const trash = (await (await page.request.get('/api/files/trash')).json()) as { id: string; original_path: string }[]
    for (const item of trash.filter((t) => t.original_path === doc.path)) await page.request.delete(`/api/files/trash/${item.id}`)
  }
})
