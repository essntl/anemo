import { expect, type Page, test } from '@playwright/test'
import { confirmWith, login, signOutAfterEach } from './helpers'

/*
 * Profiles & Skills and the Runs pages. Everything created here has a unique
 * "e2e" name and is deleted again at the end, also when a test fails.
 */

signOutAfterEach()

const suffix = () => Math.random().toString(36).slice(2, 8)

async function deleteByName(page: Page, kind: 'profiles' | 'skills', name: string) {
  const items = (await (await page.request.get(`/api/${kind}`)).json()) as { id: string; name: string }[]
  for (const item of items.filter((i) => i.name === name)) await page.request.delete(`/api/${kind}/${item.id}`)
}

test('create an agent profile and pick it in the chat', async ({ page }) => {
  const name = `e2e profile ${suffix()}`
  await login(page)
  try {
    await page.goto('/agents')
    await expect(page.getByRole('heading', { name: 'Profiles & Skills' })).toBeVisible()
    await page.getByRole('button', { name: 'New profile' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name').fill(name)
    await dialog.getByLabel('Instructions').fill('Answer briefly.')
    await dialog.getByRole('combobox', { name: 'Shell with network for this profile' }).click()
    await page.getByRole('option', { name: 'Never', exact: true }).click()
    await dialog.getByRole('button', { name: 'Create profile' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText(name)).toBeVisible()
    await expect(page.getByText('1 permission changed')).toBeVisible()

    // The chat offers it in Agent mode, and the permission chip reflects it.
    await page.goto('/')
    await page.getByRole('radio', { name: 'Agent' }).click()
    await page.getByRole('combobox', { name: 'Agent profile' }).click()
    await page.getByRole('option', { name }).click()
    await page.getByRole('button', { name: 'Permissions' }).click()
    const chip = page.getByRole('dialog')
    await expect(chip.getByText('Not allowed')).toBeVisible()
    await expect(chip.getByText('Shell with network')).toBeVisible()
  } finally {
    await deleteByName(page, 'profiles', name)
  }
})

test('import, disable, export and delete a skill', async ({ page }) => {
  const slug = `e2e-skill-${suffix()}`
  const markdown = `---\nname: ${slug}\ntitle: E2E ${slug}\ndescription: A skill made by the end-to-end tests.\ntags: [e2e]\n---\n\n# Steps\n1. Do the thing.\n`
  await login(page)
  try {
    await page.goto('/agents?tab=skills')
    await page.locator('input[type=file]').setInputFiles({ name: `${slug}.md`, mimeType: 'text/markdown', buffer: Buffer.from(markdown) })
    const row = page.locator('div.rounded-card', { hasText: slug })
    await expect(row).toBeVisible()
    await expect(row.getByText('A skill made by the end-to-end tests.')).toBeVisible()

    const toggle = row.getByRole('switch')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')

    await row.getByRole('button', { name: 'More actions' }).click()
    const exported = page.getByRole('link', { name: 'Export .md' })
    const response = await page.request.get((await exported.getAttribute('href'))!)
    expect(await response.text()).toContain(`name: ${slug}`)
    await page.keyboard.press('Escape')

    await row.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('button', { name: 'Delete' }).click()
    await confirmWith(page, 'Delete')
    await expect(row).toHaveCount(0)
  } finally {
    await deleteByName(page, 'skills', `E2E ${slug}`)
  }
})

test('runs page filters and settings show the new limits', async ({ page }) => {
  await login(page)
  await page.goto('/runs')
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Status' }).click()
  await page.getByRole('option', { name: 'Failed' }).click()
  await expect(page).toHaveURL(/status=failed/)
  await expect(page.getByRole('link', { name: 'Runs' }).first()).toBeVisible()

  // Opening a run (if there is one) shows its numbers.
  const first = page.locator('a[href^="/runs/"]').first()
  await page.goto('/runs?kind=all')
  if (await first.count()) {
    await first.click()
    await expect(page.getByText('Working time')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Runs' }).first()).toBeVisible()
  }

  // Read-only look at the permission settings (nothing is saved).
  await page.goto('/settings/permissions')
  await expect(page.getByRole('switch', { name: "Review the agent's plan first" })).toBeVisible()
  await expect(page.getByLabel('Max cost (USD)')).toBeVisible()
  await expect(page.getByLabel('Stop after failures in a row')).toBeVisible()
})

test('web settings: the search test reports an unreachable SearXNG without saving', async ({ page }) => {
  await login(page)
  await page.goto('/settings/web')
  await expect(page.getByRole('heading', { name: 'Web & Search' })).toBeVisible()
  await page.getByLabel('SearXNG URL').fill('http://127.0.0.1:9')
  await page.getByRole('button', { name: 'Test search' }).click()
  await expect(page.getByText(/not reachable/)).toBeVisible()
  await expect(page.getByLabel('Allowed hosts')).toBeVisible()
})
