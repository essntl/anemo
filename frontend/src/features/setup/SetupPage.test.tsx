import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

/* frontend-19: settings that fail to load show an error with Try again, not a blank page. */
const refetch = vi.fn()
vi.mock('@/features/settings/api', () => ({
  useSettings: () => ({ isError: true, isFetching: false, data: undefined, error: new Error('Server error'), refetch }),
  useSaveGeneral: () => ({}),
  useSaveSection: () => ({}),
}))

const { SetupPage } = await import('./SetupPage')

describe('the setup page', () => {
  it('says the settings could not be loaded and offers to try again', async () => {
    render(<MemoryRouter><SetupPage /></MemoryRouter>)
    expect(screen.getByText('Couldn’t load the setup')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Try again' }).click()
    expect(refetch).toHaveBeenCalled()
  })
})
