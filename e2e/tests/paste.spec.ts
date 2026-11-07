import { expect, type Page, test } from '@playwright/test'
import { fakeModels, login, newChat, signOutAfterEach } from './helpers'

/*
 * Pasting files into a chat (a screenshot, a copied file) attaches them, also with the
 * focus outside the message box, and a message can be just files, without text.
 * Everything created is removed again.
 */

signOutAfterEach()

// 1x1 transparent PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** Pastes files the way the browser does for a screenshot or a copied file (content in base64). */
async function paste(page: Page, target: string | null, files: { name: string; type: string; base64: string }[]) {
  await page.evaluate(
    ({ target, files }) => {
      const data = new DataTransfer()
      for (const f of files) {
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))
        data.items.add(new File([bytes], f.name, { type: f.type }))
      }
      const el = target ? document.querySelector(target)! : document.body
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    },
    { target, files },
  )
}

test('paste a screenshot or a file and send it without writing anything', async ({ page }) => {
  await login(page)
  const models = await fakeModels(page.request)
  let conversationId = ''
  try {
    await newChat(page, 'Chat', models.echo)
    const sendButton = page.getByRole('button', { name: 'Send' })
    await expect(sendButton).toBeDisabled()

    // A screenshot pasted with the focus elsewhere on the page: attached, with a name.
    await page.locator('main').click({ position: { x: 5, y: 5 } })
    await paste(page, null, [{ name: 'image.png', type: 'image/png', base64: PNG }])
    const shot = page.getByText(/^Pasted image \d\d\.\d\d\.\d\d\.png$/)
    await expect(shot).toBeVisible()
    await shot.hover() // the remove button shows on hover
    await page.getByRole('button', { name: /^Remove Pasted image/ }).click()
    await expect(shot).toHaveCount(0)

    // A file pasted into the message box keeps its name; Send works with no text.
    await paste(page, 'textarea', [{ name: 'shopping.txt', type: 'text/plain', base64: btoa('buy oat milk') }])
    await expect(page.getByText('shopping.txt', { exact: true })).toBeVisible()
    await expect(sendButton).toBeEnabled()
    await sendButton.click()
    await expect(page).toHaveURL(/\/c\//)
    conversationId = page.url().split('/c/')[1]
    // The file is the message, and it reached the model (the echo model repeats it).
    await expect(page.getByRole('link', { name: 'shopping.txt' })).toBeVisible()
    await expect(page.getByText(/buy oat milk/).last()).toBeVisible({ timeout: 15_000 })
    await expect(sendButton).toBeDisabled()
  } finally {
    if (conversationId) await page.request.delete(`/api/conversations/${conversationId}`).catch(() => undefined)
  }
})
