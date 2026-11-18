import { expect, test } from '@playwright/test'
import { fakeModels, login, newChat, pickModel, send, signOutAfterEach } from './helpers'

signOutAfterEach()

test('the reasoning slider sets how hard a model thinks, and the answer gets it', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request, ['reasoning'])
  const settings = await (await page.request.get('/api/settings')).json()

  try {
    // A model that cannot reason has no slider next to it.
    await newChat(page, 'Chat', models.echo)
    const chip = page.getByRole('button', { name: /^Reasoning: / })
    await expect(chip).toHaveCount(0)

    await pickModel(page, models.reasoning)
    await chip.click()
    const slider = page.getByRole('slider', { name: 'Reasoning effort' })
    await slider.focus()
    await slider.press('End')
    await expect(slider).toHaveAttribute('aria-valuetext', /^Max: /)
    await expect(slider).toHaveAttribute('data-level', 'max')
    await expect(chip).toHaveAccessibleName('Reasoning: Max')
    await page.keyboard.press('Escape')

    // Saved as the default for chats.
    await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).models.reasoning_effort).toBe('max')

    await send(page, 'think hard')
    await expect(page.getByText('You said: think hard')).toBeVisible()
    // The fake model says in its reasoning which level it was asked for.
    const id = page.url().split('/c/')[1].split(/[?#/]/)[0]
    await expect
      .poll(async () => (await (await page.request.get(`/api/conversations/${id}/messages`)).json()).at(-1).reasoning)
      .toContain('at max effort')
  } finally {
    // Leave the default as it was for the other tests.
    await page.request.put('/api/settings/models', { data: settings.models })
  }
})
