import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/features/profiles/api', () => ({ useSlashSkills: () => [] }))
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }))
const sketches = [
  { id: 'sk-1', title: 'Kitchen plan', kind: 'sketch', folder: '', path: 'documents/kitchen-plan.sketch.md', updated_at: '2026-11-10T10:00:00Z' },
  { id: 'doc-1', title: 'Shopping list', kind: 'markdown', folder: '', path: 'documents/shopping-list.md', updated_at: '2026-11-10T10:00:00Z' },
]
vi.mock('@/features/documents/api', () => ({
  useDocuments: () => ({ data: { documents: sketches, folders: [] }, isSuccess: true, isPending: false, error: null }),
}))
const attachment = { id: 'att-7', filename: 'kitchen-plan.png', mime: 'image/png', size: 2048, kind: 'image', extraction_note: null }
const sketchForChat = vi.hoisted(() => vi.fn())
vi.mock('@/features/sketch/ensurePreview', () => ({ sketchForChat }))

const { Composer } = await import('./Composer')

function renderComposer(onSend: (...args: unknown[]) => void) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Composer running={false} onSend={onSend} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('a sketch as context for a message', () => {
  it('is picked from the + menu, made into an image and sent like an uploaded one', async () => {
    let finish!: (value: typeof attachment) => void
    sketchForChat.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const onSend = vi.fn(() => Promise.resolve())
    renderComposer(onSend)

    await userEvent.click(screen.getByRole('button', { name: 'Add to the message' }))
    await userEvent.click(screen.getByRole('button', { name: /Sketch…/ }))
    // Only sketches are offered.
    expect(screen.queryByText('Shopping list')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Kitchen plan/ }))

    expect(sketchForChat).toHaveBeenCalledWith('sk-1', expect.anything())
    expect(screen.getByText('Kitchen plan.png')).toBeInTheDocument() // shown while it is made
    finish(attachment)
    await vi.waitFor(() => expect(document.querySelector('img[src="/api/attachments/att-7/content"]')).not.toBeNull())

    await userEvent.type(screen.getByRole('textbox'), 'What is missing here?{Enter}')
    expect(onSend).toHaveBeenCalledWith('What is missing here?', ['att-7'], [], null)
  })

  it('can come with a new chat that starts from the sketch', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <Composer running={false} onSend={vi.fn()} initialAttachments={[attachment]} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getByText('kitchen-plan.png')).toBeInTheDocument()
  })
})
