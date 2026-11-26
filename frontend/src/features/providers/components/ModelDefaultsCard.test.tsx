import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Model, ModelDefaults } from '../api'

// The real Select is a Radix popup; a plain list of its options is enough here.
vi.mock('@/components/ui/Select', () => ({
  Select: ({ options, 'aria-label': label }: { options: { value: string; label: string }[]; 'aria-label': string }) => (
    <ul aria-label={label}>{options.map((o) => <li key={o.value}>{o.label}</li>)}</ul>
  ),
}))
vi.mock('../api', () => ({
  useSaveModelDefaults: () => ({ mutate: vi.fn(), isPending: false, isError: false, isSuccess: false }),
}))

const { ModelDefaultsCard } = await import('./ModelDefaultsCard')

const model = (id: string, name: string, capabilities: Record<string, boolean>) =>
  ({ id, display_name: name, provider_name: 'P', enabled: true, capabilities }) as unknown as Model

describe('the image generation default', () => {
  it('offers only image models, and never falls back to the chat model', () => {
    const models = [
      model('m1', 'GPT-5', { chat: true, tools: true }),
      model('m2', 'gpt-image-1.5', { chat: false, image_generation: true }),
    ]
    render(<ModelDefaultsCard initial={{ fallbacks: {} } as unknown as ModelDefaults} models={models} />)
    const image = within(screen.getByRole('list', { name: 'Image generation' }))
    expect(image.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Not set (no image generation)',
      'gpt-image-1.5 — P',
    ])
    // And the image model is not offered for chats.
    const chat = within(screen.getByRole('list', { name: 'Chat' }))
    expect(chat.queryByText('gpt-image-1.5 — P')).not.toBeInTheDocument()
  })
})
