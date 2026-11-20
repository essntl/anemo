import { expect, test } from '@playwright/test'
import { fakeModels, login, newChat, send, signOutAfterEach } from './helpers'

/*
 * The response timer (spec 03): a live timer while the assistant works, counted from
 * the server's start, and the duration of every finished answer.
 */

signOutAfterEach()

const seconds = (text: string | null) => {
  const m = /(?:(\d+) m )?(\d+) s/.exec(text ?? '')
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : NaN
}

test('an answer shows how long it took, with the details', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  await newChat(page, 'Chat', models.echo)
  await send(page, 'hello timer')
  await expect(page.getByText('You said: hello timer')).toBeVisible()
  const duration = page.getByRole('button', { name: /^How long the answer took: \d+ s$/ })
  await expect(duration).toBeVisible()
  await duration.hover()
  const details = page.getByRole('tooltip')
  await expect(details.getByText('Time to first text')).toBeVisible()
  await expect(details.getByText('Tool calls')).toBeVisible()
  await page.request.delete(page.url().replace(/.*\/c\//, '/api/conversations/'))
})

test('the live timer survives a reload, and a stopped answer is marked', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  await newChat(page, 'Chat', models.slow)
  const words = Array.from({ length: 60 }, (_, i) => `t${i}`).join(' ')
  await send(page, words)
  const timer = page.getByLabel('Time this answer has taken')
  await expect(page.getByText(/You said: t0 t1/)).toBeVisible()
  await expect.poll(async () => seconds(await timer.textContent()), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)

  // After a reload it goes on from the server's start, not from zero.
  await page.reload()
  await expect.poll(async () => seconds(await timer.textContent()), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)

  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByRole('button', { name: /^How long the answer took: Stopped after \d+ s$/ })).toBeVisible()
  await page.request.delete(page.url().replace(/.*\/c\//, '/api/conversations/'))
})

test('while the agent waits for your answer, the timer says so', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  await newChat(page, 'Agent', models.agent)
  await send(page, 'Paint the fence, but ask me first')
  const card = page.getByRole('group', { name: "The agent's question" })
  await expect(card.getByText('Which colour do you want?')).toBeVisible()
  // The agent's timer stands beside its activity bar, stopped while it waits.
  await expect(page.getByText('· waiting for you', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Green' }).click()
  await expect(page.getByText('Thanks. The user answered: Green')).toBeVisible()
  await expect(page.getByRole('button', { name: /^How long the answer took: \d+ s$/ })).toBeVisible()
  await page.request.delete(page.url().replace(/.*\/c\//, '/api/conversations/'))
})
