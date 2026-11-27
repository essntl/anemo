import { expect, test } from '@playwright/test'
import { fakeModels, login, newChat, send } from './helpers'

/**
 * The Inbox as an overview: an agent's question waits under Needs you and is answered
 * there, without opening the chat; the chat then goes on with the answer.
 */
test('answer an agent’s question from the Inbox', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  await newChat(page, 'Agent', models.agent)
  await send(page, 'Plan the garden, but ask me first')
  await expect(page).toHaveURL(/\/c\//)
  await expect(page.getByRole('group', { name: "The agent's question" })).toBeVisible()
  const chatUrl = page.url()
  const id = chatUrl.replace(/.*\/c\//, '')
  // Other tests ask the same question at the same time: find this chat's row by its title.
  const title = `Garden ${Date.now()}`
  expect((await page.request.patch(`/api/conversations/${id}`, { data: { title } })).ok()).toBeTruthy()

  try {
    await page.goto('/notifications')
    const needs = page.getByRole('region', { name: /Needs you/ })
    const row = needs.getByRole('listitem').filter({ hasText: `In “${title}”` })
    await expect(row.getByText('Which colour do you want?')).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Inbox overview' })).toContainText(/\d+ needs? you/)
    await row.getByRole('button', { name: 'Green' }).click()
    await expect(row).toHaveCount(0)

    await page.goto(chatUrl)
    await expect(page.getByText('Thanks. The user answered: Green')).toBeVisible()
  } finally {
    await page.request.delete(`/api/conversations/${id}`)
  }
})

test('the Inbox shows its sections and the notification filters', async ({ page }) => {
  await login(page)
  await page.goto('/notifications')
  const list = page.getByRole('region', { name: /Notifications/ })
  await expect(list.getByRole('tablist', { name: 'Which notifications' })).toBeVisible()
  await expect(list.getByRole('button', { name: 'Everything' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('region', { name: /In progress/ })).toBeVisible()
})
