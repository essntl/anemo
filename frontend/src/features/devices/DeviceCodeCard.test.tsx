import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const mutate = vi.fn()
const code = { keep_days: 30, auto_continue: false }
vi.mock('@/features/settings/api', () => ({
  useSettings: () => ({ data: { code } }),
  useSaveSection: () => ({ mutate, isPending: false }),
}))

const { DeviceCodeCard } = await import('./DeviceCodeCard')

describe('Settings → Devices: auto continue', () => {
  it('turns the default on with the rest of the code section', async () => {
    render(<DeviceCodeCard />)
    const toggle = screen.getByRole('switch', { name: 'Auto continue Claude Code jobs' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(toggle)
    expect(mutate).toHaveBeenCalledWith({ keep_days: 30, auto_continue: true })
  })
})
