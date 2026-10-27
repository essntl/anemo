import { expect, test } from '@playwright/test'
import { login, removeTrack, signOutAfterEach, startMusic } from './helpers'

/*
 * The Dynamic Island: appears when music plays, keeps going across pages, and its
 * expanded controls play and pause. Uses the app's own sound file (no internet).
 */

signOutAfterEach()

test('play and pause music from the Island on another page', async ({ page, baseURL }) => {
  await login(page)
  try {
    await startMusic(page, baseURL!)
    // Go elsewhere inside the app: the music and the Island stay.
    await page.getByRole('link', { name: 'Tasks', exact: true }).first().click()
    await expect(page).toHaveURL(/\/tasks/)
    const island = page.getByTestId('island')
    await expect(island).toHaveAttribute('data-mode', /compact|alert/)
    await expect(island).toHaveAttribute('data-mode', 'compact', { timeout: 10_000 })
    await island.getByRole('button', { name: /Show controls/ }).click()
    await expect(island).toHaveAttribute('data-mode', 'expanded')
    await island.getByRole('button', { name: 'Pause music' }).click()
    await expect(island.getByRole('button', { name: 'Play music' })).toBeVisible()
    await island.getByRole('button', { name: 'Play music' }).click()
    await expect(island.getByRole('button', { name: 'Pause music' })).toBeVisible()
    // Esc closes it again.
    await page.keyboard.press('Escape')
    await expect(island).toHaveAttribute('data-mode', 'compact')
  } finally {
    await removeTrack(page, baseURL!)
  }
})

test('the Island shows the running timer and its controls', async ({ page }) => {
  await login(page)
  await page.goto('/focus')
  await expect(page.getByTestId('island')).toHaveCount(0)
  await page.getByRole('button', { name: 'Start timer' }).click()
  const island = page.getByTestId('island')
  await expect(island).toBeVisible()
  await island.getByRole('button', { name: /Show controls/ }).click()
  await island.getByRole('button', { name: 'Pause timer' }).click()
  await expect(page.getByRole('button', { name: 'Start timer' }).first()).toBeVisible()
  await island.getByRole('button', { name: 'Open Focus' }).click()
  await expect(page).toHaveURL(/\/focus/)
  // Reset before a minute has passed: nothing is recorded.
  await page.getByRole('button', { name: 'Reset timer' }).click()
  await expect(island).toHaveCount(0)
})
