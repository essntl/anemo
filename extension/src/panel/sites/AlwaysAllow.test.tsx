import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AlwaysAllow } from './AlwaysAllow'

function fakeChrome(granted: string[]) {
  const asked: string[][] = []
  vi.stubGlobal('chrome', {
    permissions: {
      contains: async ({ origins }: { origins: string[] }) => origins.every((o) => granted.includes(o)),
      request: async ({ origins }: { origins: string[] }) => {
        asked.push(origins)
        granted.push(...origins)
        return true
      },
    },
  })
  return asked
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AlwaysAllow', () => {
  it('offers to always allow a site read thanks to a click, and asks Chrome for that site only', async () => {
    const asked = fakeChrome([])
    render(<AlwaysAllow url="https://www.nature.com/articles/x" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Always allow on nature.com' }))
    expect(asked).toEqual([['https://www.nature.com/*']])
    expect(await screen.findByText('Anemo can now read nature.com from the panel.')).toBeTruthy()
  })

  it('shows nothing where access is already given, or for pages that aren’t sites', async () => {
    fakeChrome(['https://www.nature.com/*'])
    const { container, rerender } = render(<AlwaysAllow url="https://www.nature.com/x" />)
    await new Promise((r) => setTimeout(r, 10))
    expect(container.textContent).toBe('')
    rerender(<AlwaysAllow url="chrome://settings" />)
    expect(container.textContent).toBe('')
  })
})
