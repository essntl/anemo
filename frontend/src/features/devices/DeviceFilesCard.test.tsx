import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mutate = vi.fn()
const files = { show_documents_folder: true, device_file_max_mb: 50 }
vi.mock('@/features/settings/api', () => ({
  useSettings: () => ({ data: { files } }),
  useSaveSection: () => ({ mutate, isPending: false, isError: false }),
}))

const { DeviceFilesCard } = await import('./DeviceFilesCard')

describe('Settings → Devices: files on your computers', () => {
  beforeEach(() => vi.clearAllMocks())

  it('saves a new largest file size with the rest of the files section', async () => {
    render(<DeviceFilesCard />)
    const input = screen.getByLabelText('Largest file (MB)')
    expect(input).toHaveValue(50)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await userEvent.clear(input)
    await userEvent.type(input, '120')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(mutate).toHaveBeenCalledWith({ show_documents_folder: true, device_file_max_mb: 120 })
  })

  it('refuses a size outside 1 to 200 MB', async () => {
    render(<DeviceFilesCard />)
    const input = screen.getByLabelText('Largest file (MB)')
    await userEvent.clear(input)
    await userEvent.type(input, '500')
    expect(screen.getByText('From 1 to 200 MB.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
