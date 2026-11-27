import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { useToasts } from '@/components/ui/toast'
import type { CommandHost } from '../commands'
import { Composer } from './Composer'

// A skill called like a command: the command wins when typed, the skill stays in the menu.
const skills = vi.hoisted(() => [
  { id: 'sk1', slug: 'model', name: 'Model', description: 'Build a data model', hint: 'Build a data model', icon: 'sparkles', builtin: false },
])
vi.mock('@/features/profiles/api', () => ({ useSlashSkills: () => skills }))
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }))

function host(run = vi.fn((name: string, value: string): string | void => `${name}=${value}`)): CommandHost & { run: typeof run } {
  return {
    names: ['model', 'mode', 'rename', 'new', 'help'],
    options: (name) => (name === 'model'
      ? [{ value: 'm1', label: 'GPT-5.5' }, { value: 'm2', label: 'Claude Sonnet 5.5', detail: 'current' }, { value: 'm3', label: 'Claude Opus 5.5' }]
      : name === 'mode' ? [{ value: 'chat', label: 'Chat' }, { value: 'agent', label: 'Agent' }] : []),
    run,
  }
}

function renderComposer(commands: CommandHost, onSend = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Composer running={false} onSend={onSend} commands={commands} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { box: screen.getByRole('textbox'), onSend }
}

const options = () => within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)

describe('slash commands in the message box', () => {
  it('come first, before the skills, and a skill named like one stays reachable', async () => {
    const { box } = renderComposer(host())
    await userEvent.type(box, '/mo')
    const listed = options()
    expect(listed[0]).toMatch(/^\/model/)
    expect(listed[1]).toMatch(/^\/mode/)
    expect(listed[2]).toMatch(/^Model\/model/) // the skill, in the Skills group
    expect(listed[0]).toContain('re-reads this chat')
  })

  it('/model: arrows and Enter choose a model, with the keyboard only; nothing is sent', async () => {
    const h = host()
    const { box, onSend } = renderComposer(h)
    await userEvent.type(box, '/mod{Enter}') // the first one: /model
    expect(box).toHaveValue('/model ')
    expect(options()).toEqual(['GPT-5.5', 'Claude Sonnet 5.5current', 'Claude Opus 5.5'])
    await userEvent.type(box, 'cl')
    expect(options()).toEqual(['Claude Sonnet 5.5current', 'Claude Opus 5.5'])
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(h.run).toHaveBeenCalledWith('model', 'm3')
    expect(box).toHaveValue('')
    expect(onSend).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(useToasts.getState().toasts.at(-1)?.message).toBe('model=m3'))
  })

  it('fuzzy: the letters in order are enough', async () => {
    const h = host()
    const { box } = renderComposer(h)
    await userEvent.type(box, '/model gpt55')
    expect(options()).toEqual(['GPT-5.5'])
  })

  it('a command never goes out as a message, even when nothing matches', async () => {
    const h = host()
    const { box, onSend } = renderComposer(h)
    await userEvent.type(box, '/model nothing-like-it{Enter}')
    expect(onSend).not.toHaveBeenCalled()
    expect(h.run).not.toHaveBeenCalled()
    expect(box).toHaveValue('/model nothing-like-it')
  })

  it('/rename takes its text; /new runs at once; /help shows everything', async () => {
    const h = host()
    const { box, onSend } = renderComposer(h)
    await userEvent.type(box, '/rename Trip to Lviv{Enter}')
    expect(h.run).toHaveBeenLastCalledWith('rename', 'Trip to Lviv')
    await userEvent.type(box, '/new{Enter}')
    expect(h.run).toHaveBeenLastCalledWith('new', '')
    await userEvent.type(box, '/help{Enter}')
    expect(box).toHaveValue('/')
    expect(options().length).toBe(6) // 5 commands and the skill
    expect(onSend).not.toHaveBeenCalled()
  })

  it('a command that fails puts its text back', async () => {
    const h = host(vi.fn(() => { throw new Error('no') }))
    const { box } = renderComposer(h)
    await userEvent.type(box, '/rename X{Enter}')
    await vi.waitFor(() => expect(box).toHaveValue('/rename X'))
  })
})
