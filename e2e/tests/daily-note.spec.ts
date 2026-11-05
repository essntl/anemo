import { expect, type APIRequestContext, test } from '@playwright/test'
import { login, signOutAfterEach } from './helpers'

/*
 * Home's Daily note: add, tick, edit, move (keyboard) and delete short notes, go back
 * a day and return to today. The notes are a document per day; what was there before
 * is put back afterwards (or the note removed when there was none).
 */

signOutAfterEach()

type Note = { date: string; today: string; path: string; document: { id: string; content: string; hash: string } | null }

const getNote = async (request: APIRequestContext, day: string) => (await (await request.get(`/api/daily-notes/${day}`)).json()) as Note
const contentOf = async (request: APIRequestContext, day: string) => (await getNote(request, day)).document?.content ?? ''

async function restore(request: APIRequestContext, day: string, before: Note['document']) {
  const now = await getNote(request, day)
  if (!now.document) return
  if (before) await request.put(`/api/daily-notes/${day}`, { data: { content: before.content, base_hash: now.document.hash } })
  else await request.delete(`/api/documents/${now.document.id}`)
}

test('daily note: add, tick, edit, move and delete notes, and go back a day', async ({ page }) => {
  await login(page)
  const today = (await getNote(page.request, 'today')).today
  const [y, m, d] = today.split('-').map(Number)
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
  const before = { today: (await getNote(page.request, today)).document, yesterday: (await getNote(page.request, yesterday)).document }
  const stamp = Date.now()
  const a = `E2E call Sam ${stamp}`
  const b = `E2E pay rent ${stamp}`
  const b2 = `E2E pay rent by Friday ${stamp}`
  const old = `E2E yesterday ${stamp}`
  try {
    // The Home layout is left alone: home.spec.ts changes it at the same time. (Where
    // the widget goes in a layout is covered by layout.test.ts.)
    await page.goto('/home')
    const widget = page.locator('[data-widget="daily"]')
    await expect(widget.getByRole('heading', { name: 'Daily note', exact: true })).toBeVisible()
    await expect(widget.getByTestId('daily-note-day')).toHaveText(/^Today, /)

    // Enter adds a note; it is saved as a checklist line in the day's document.
    const add = widget.getByRole('textbox', { name: 'Add a note for today', exact: true })
    await add.fill(a)
    await add.press('Enter')
    await expect(add).toHaveValue('')
    await add.fill(b)
    await add.press('Enter')
    await expect(widget.getByRole('button', { name: b, exact: true })).toBeVisible()
    await expect.poll(() => contentOf(page.request, today)).toContain(`- [ ] ${a}\n- [ ] ${b}\n`)

    // Tick one off.
    await widget.getByRole('checkbox', { name: `Tick off “${a}”`, exact: true }).click()
    await expect(widget.getByRole('checkbox', { name: `Untick “${a}”`, exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => contentOf(page.request, today)).toContain(`- [x] ${a}`)

    // Edit one in place.
    await widget.getByRole('button', { name: b, exact: true }).click()
    const edit = widget.getByRole('textbox', { name: `Edit “${b}”`, exact: true })
    await edit.fill(b2)
    await edit.press('Enter')
    await expect(widget.getByRole('button', { name: b2, exact: true })).toBeVisible()
    await expect.poll(() => contentOf(page.request, today)).toContain(`- [ ] ${b2}`)

    // Move it up with the keyboard on its grip; it keeps the focus.
    const grip = widget.getByRole('button', { name: `Move “${b2}”`, exact: true })
    await grip.focus()
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => contentOf(page.request, today)).toContain(`- [ ] ${b2}\n- [x] ${a}\n`)
    await expect(grip).toBeFocused()

    // Delete one.
    await widget.getByRole('button', { name: `Delete “${a}”`, exact: true }).click()
    await expect(widget.getByRole('checkbox', { name: `Untick “${a}”`, exact: true })).toHaveCount(0)
    await expect.poll(() => contentOf(page.request, today)).not.toContain(a)

    // The day before has its own note.
    await widget.getByRole('button', { name: 'Previous day', exact: true }).click()
    await expect(widget.getByTestId('daily-note-day')).not.toHaveText(/^Today/)
    await expect(widget.getByRole('button', { name: b2, exact: true })).toHaveCount(0)
    await expect(widget.getByRole('button', { name: 'Next day', exact: true })).toBeEnabled()
    const addOld = widget.getByRole('textbox', { name: 'Add a note for this day', exact: true })
    await addOld.fill(old)
    await addOld.press('Enter')
    await expect.poll(() => contentOf(page.request, yesterday)).toContain(`- [ ] ${old}`)

    // Today brings back today's notes.
    await widget.getByRole('button', { name: 'Today', exact: true }).click()
    await expect(widget.getByTestId('daily-note-day')).toHaveText(/^Today, /)
    await expect(widget.getByRole('button', { name: b2, exact: true })).toBeVisible()
    await expect(widget.getByRole('button', { name: old, exact: true })).toHaveCount(0)
    await expect(widget.getByRole('button', { name: 'Next day', exact: true })).toBeDisabled()

    // ↗ opens the day's document.
    await widget.getByRole('link', { name: 'Open Daily note', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+$/)
  } finally {
    await restore(page.request, today, before.today)
    await restore(page.request, yesterday, before.yesterday)
  }
})
