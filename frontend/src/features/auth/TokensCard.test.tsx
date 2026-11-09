import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const create = vi.fn()
const revoke = vi.fn()
vi.mock('./api', () => ({
  useTokens: () => ({
    data: [
      { id: 't1', name: 'Chrome on laptop', prefix: 'anemo_abcd', created_at: '2026-11-01T10:00:00Z', last_used_at: null, last_used_ip: null, current: false },
    ],
  }),
  useCreateToken: () => ({
    isPending: false,
    isError: false,
    mutate: (name: string, opts: { onSuccess: (t: { token: string }) => void }) => {
      create(name)
      opts.onSuccess({ token: 'anemo_secret-value' })
    },
  }),
  useRevokeToken: () => ({ mutate: revoke }),
}))
const confirm = vi.fn()
vi.mock('@/components/ui/dialogs', () => ({ confirmDialog: (...a: unknown[]) => confirm(...a) }))

const { TokensCard } = await import('./TokensCard')

describe('the tokens card', () => {
  it('lists tokens by name and prefix, never the token', () => {
    render(<TokensCard />)
    expect(screen.getByText('Chrome on laptop')).toBeInTheDocument()
    expect(screen.getByText('anemo_abcd…')).toBeInTheDocument()
    expect(screen.getByText(/never used/)).toBeInTheDocument()
  })

  it('shows a new token once, until Done', async () => {
    render(<TokensCard />)
    await userEvent.type(screen.getByPlaceholderText('Chrome on my laptop'), 'Work laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }))
    expect(create).toHaveBeenCalledWith('Work laptop')
    expect(screen.getByTestId('new-token')).toHaveTextContent('anemo_secret-value')
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByTestId('new-token')).not.toBeInTheDocument()
  })

  it('revokes only after confirming', async () => {
    render(<TokensCard />)
    confirm.mockResolvedValueOnce(false)
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(revoke).not.toHaveBeenCalled()
    confirm.mockResolvedValueOnce(true)
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(revoke).toHaveBeenCalledWith('t1')
  })
})
