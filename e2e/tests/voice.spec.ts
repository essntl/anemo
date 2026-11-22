import { expect, test, type Page } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * Settings → Voice (docs/specs/05-voice-android.md, "Settings"): every setting is saved
 * and kept after a reload, and the numbers stay within their limits. What the test
 * changes is put back afterwards; the agent profile it makes is deleted.
 */

signOutAfterEach()

type Voice = {
  profile_id: string | null
  model_id: string | null
  follow_up_minutes: number
  max_spoken_chars: number
  approvals_by_voice: boolean
  chat: 'daily' | 'single'
}

async function voiceSettings(page: Page): Promise<Voice> {
  return (await (await page.request.get('/api/settings')).json()).voice as Voice
}

const followUp = (page: Page) => page.getByRole('spinbutton', { name: 'Follow-up window (minutes)' })
const longest = (page: Page) => page.getByRole('spinbutton', { name: 'Longest answer read out (characters)' })
const approvals = (page: Page) => page.getByRole('switch', { name: 'Allow approvals by voice' })
const save = (page: Page) => page.getByRole('button', { name: 'Save' })

async function saved(page: Page) {
  await save(page).click()
  // Saved: the form is no longer different from what the server has.
  await expect(save(page)).toBeDisabled()
}

test('every voice setting is saved and kept after a reload', async ({ page }) => {
  await login(page)
  const before = await voiceSettings(page)
  const profileName = `E2E voice agent ${Date.now().toString(36)}`
  const made = await page.request.post('/api/profiles', { data: { name: profileName } })
  expect(made.ok(), await made.text()).toBe(true)
  const profile = (await made.json()) as { id: string }
  // A model an agent can use (one with tools): the choice for "Model for voice requests".
  type Model = { id: string; display_name: string; enabled: boolean; provider_enabled: boolean; capabilities: { tools?: boolean } }
  const models = (await (await page.request.get('/api/models')).json()) as Model[]
  const model = models.find((m) => m.enabled && m.provider_enabled && m.capabilities.tools)
  expect(model, 'the test install has a model with tools').toBeTruthy()
  try {
    await page.goto('/settings/voice')
    await expect(save(page)).toBeDisabled() // nothing changed yet

    await page.getByRole('combobox', { name: 'Model for voice requests' }).click()
    await page.getByRole('option', { name: model!.display_name, exact: true }).click()

    await page.getByRole('combobox', { name: 'Agent for voice requests' }).click()
    await page.getByRole('option', { name: profileName }).click()
    await page.getByRole('combobox', { name: 'The Voice chat' }).click()
    await page.getByRole('option', { name: 'One that keeps going' }).click()
    await followUp(page).fill('12')
    await longest(page).fill('900')
    await longest(page).blur()
    const wasOn = before.approvals_by_voice
    await approvals(page).click()
    await expect(approvals(page)).toHaveAttribute('aria-checked', String(!wasOn))
    await saved(page)

    await page.reload()
    await expect(page.getByRole('combobox', { name: 'Agent for voice requests' })).toHaveText(profileName)
    await expect(page.getByRole('combobox', { name: 'Model for voice requests' })).toHaveText(model!.display_name)
    await expect(page.getByRole('combobox', { name: 'The Voice chat' })).toHaveText('One that keeps going')
    await expect(followUp(page)).toHaveValue('12')
    await expect(longest(page)).toHaveValue('900')
    await expect(approvals(page)).toHaveAttribute('aria-checked', String(!wasOn))
    expect(await voiceSettings(page)).toEqual({
      profile_id: profile.id,
      model_id: model!.id,
      follow_up_minutes: 12,
      max_spoken_chars: 900,
      approvals_by_voice: !wasOn,
      chat: 'single',
    })

    // And back to the defaults' kind of values, through the same form.
    await page.getByRole('combobox', { name: 'Agent for voice requests' }).click()
    await page.getByRole('option', { name: 'Default agent' }).click()
    await page.getByRole('combobox', { name: 'Model for voice requests' }).click()
    await page.getByRole('option', { name: 'The agent’s model' }).click()
    await page.getByRole('combobox', { name: 'The Voice chat' }).click()
    await page.getByRole('option', { name: 'A new one each day' }).click()
    await followUp(page).fill('0') // 0 turns follow-ups off
    await saved(page)
    await page.reload()
    await expect(page.getByRole('combobox', { name: 'Agent for voice requests' })).toHaveText('Default agent')
    await expect(page.getByRole('combobox', { name: 'The Voice chat' })).toHaveText('A new one each day')
    await expect(followUp(page)).toHaveValue('0')
    const now = await voiceSettings(page)
    expect([now.profile_id, now.model_id, now.chat, now.follow_up_minutes]).toEqual([null, null, 'daily', 0])
  } finally {
    await page.request.put('/api/settings/voice', { data: before })
    await page.request.delete(`/api/profiles/${profile.id}`)
  }
})

test('the numbers stay within their limits', async ({ page }) => {
  await login(page)
  const before = await voiceSettings(page)
  try {
    await page.goto('/settings/voice')
    // The follow-up window is 0 to 60 minutes.
    await followUp(page).fill('75')
    await expect(followUp(page)).toHaveValue('60')
    await followUp(page).fill('-3')
    await expect(followUp(page)).toHaveValue('0')
    await followUp(page).fill('45')
    // The longest answer read out is 100 to 2000 characters (set when the field is left).
    await longest(page).fill('50')
    await longest(page).blur()
    await expect(longest(page)).toHaveValue('100')
    await longest(page).fill('5000')
    await longest(page).blur()
    await expect(longest(page)).toHaveValue('2000')
    await saved(page)
    await page.reload()
    await expect(followUp(page)).toHaveValue('45')
    await expect(longest(page)).toHaveValue('2000')
    const now = await voiceSettings(page)
    expect([now.follow_up_minutes, now.max_spoken_chars]).toEqual([45, 2000])

    // The server keeps the limits too, whatever a client sends.
    for (const bad of [{ follow_up_minutes: 61 }, { max_spoken_chars: 99 }, { max_spoken_chars: 2001 }, { chat: 'weekly' }]) {
      expect((await page.request.put('/api/settings/voice', { data: bad })).status()).toBe(422)
    }
  } finally {
    await page.request.put('/api/settings/voice', { data: before })
  }
})
