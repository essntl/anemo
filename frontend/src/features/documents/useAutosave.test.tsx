import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type { DocumentContent } from './api'
import * as api from './api'
import { useAutosave } from './useAutosave'

const DOC: DocumentContent = {
  id: 'doc-1',
  path: 'documents/a.md',
  folder: '',
  title: 'A',
  word_count: 1,
  last_editor: 'user',
  updated_at: '2026-10-01T00:00:00Z',
  content: '# A\n',
  hash: 'h0',
}

function setup() {
  const client = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return renderHook(() => useAutosave(DOC), { wrapper })
}

describe('useAutosave', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('saves once after typing stops, based on the version that was opened', async () => {
    const save = vi.spyOn(api, 'saveDocument').mockResolvedValue({ ...DOC, content: '# A\n\nab', hash: 'h1' })
    const { result } = setup()
    act(() => result.current.setText('# A\n\na'))
    act(() => result.current.setText('# A\n\nab'))
    expect(result.current.state).toBe('unsaved')
    expect(save).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(1300))
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('doc-1', '# A\n\nab', 'h0')
    expect(result.current.state).toBe('saved')
    expect(result.current.baseHash()).toBe('h1')
  })

  it('stops saving on a conflict until the user chooses to overwrite', async () => {
    const conflict = new ApiError(409, 'conflict_base_hash', 'changed elsewhere')
    const save = vi.spyOn(api, 'saveDocument').mockRejectedValueOnce(conflict)
    const { result } = setup()
    act(() => result.current.setText('mine'))
    await act(() => vi.advanceTimersByTimeAsync(1300))
    expect(result.current.state).toBe('conflict')

    act(() => result.current.setText('mine, edited further'))
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(save).toHaveBeenCalledTimes(1) // nothing is written while the choice is open

    save.mockResolvedValue({ ...DOC, content: 'mine, edited further', hash: 'h2' })
    await act(async () => result.current.overwrite())
    expect(save).toHaveBeenLastCalledWith('doc-1', 'mine, edited further', null)
    expect(result.current.state).toBe('saved')
  })
})
