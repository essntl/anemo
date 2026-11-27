import { expect, type Page, test } from '@playwright/test'
import { fakeModels, login, send, signOutAfterEach } from './helpers'

/*
 * A long chat (more than VIRTUAL_FROM = 60 messages) has only the messages in sight in
 * the page. It still opens at the bottom, scrolls to its first message, follows a new
 * answer at the bottom, and keeps the reader's place while they read further up.
 */

signOutAfterEach()

const TURNS = 32 // 64 messages

async function waitForAnswers(page: Page, id: string, count: number) {
  type M = { role: string; status: string | null }
  await expect
    .poll(async () => {
      const list = (await (await page.request.get(`/api/conversations/${id}/messages`)).json()) as M[]
      return list.filter((m) => m.role === 'assistant' && m.status !== 'streaming' && m.status !== 'pending').length
    }, { timeout: 60_000 })
    .toBe(count)
}

test('a long chat is windowed, opens at the bottom and follows new answers', async ({ page }) => {
  test.setTimeout(120_000)
  await login(page)
  const models = await fakeModels(page.request)
  const chat = (await (await page.request.post('/api/conversations', { data: { title: 'E2E long chat', model_id: models.echo } })).json()) as { id: string }
  try {
    for (let i = 0; i < TURNS; i++) {
      const r = await page.request.post(`/api/conversations/${chat.id}/turns`, { data: { text: `Question number ${i}`, model_id: models.echo } })
      expect(r.status()).toBe(202)
      await waitForAnswers(page, chat.id, i + 1)
    }

    await page.goto(`/c/${chat.id}`)
    // At the bottom: the last answer is in sight.
    await expect(page.getByText(`Question number ${TURNS - 1}`).last()).toBeInViewport()
    // Windowed: far fewer messages in the page than in the chat.
    const list = page.getByTestId('virtual-messages')
    await expect(list).toBeVisible()
    const drawn = await list.locator(':scope > [data-index]').count()
    expect(drawn).toBeGreaterThan(0)
    expect(drawn).toBeLessThan(TURNS * 2)
    await expect(page.getByText('Question number 0', { exact: true })).toHaveCount(0)

    // Scrolled to the top, the first message is drawn.
    const scroller = page.locator('main div.overflow-y-auto').filter({ has: list })
    await scroller.evaluate((el) => { el.scrollTop = 0 })
    await expect(page.getByText('Question number 0', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(`Question number ${TURNS - 1}`, { exact: true })).toHaveCount(0)

    // Reading further up: a new answer doesn't pull the view down.
    const before = await scroller.evaluate((el) => el.scrollTop)
    await page.request.post(`/api/conversations/${chat.id}/turns`, { data: { text: 'Sent from elsewhere', model_id: models.echo } })
    await waitForAnswers(page, chat.id, TURNS + 1)
    await page.waitForTimeout(500)
    expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - before)).toBeLessThan(5)

    // Back at the bottom, a message sent here and its answer stay in sight.
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(page.getByText('Sent from elsewhere').last()).toBeInViewport()
    await send(page, 'The last question')
    await expect(page.getByText('You said: The last question')).toBeInViewport()
  } finally {
    await page.request.delete(`/api/conversations/${chat.id}`)
  }
})
