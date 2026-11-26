import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type { DocumentContent } from '@/features/documents/api'
import type { SketchData, Stroke } from './model'

const api = vi.hoisted(() => ({
  saveSketch: vi.fn(),
  fetchDocument: vi.fn(),
  uploadPreview: vi.fn(),
}))
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), ...api }))
const render = vi.hoisted(() => vi.fn(async () => new Blob(['png'], { type: 'image/png' })))
vi.mock('./canvas/preview', () => ({ renderPreview: render }))

const { useSketchAutosave, SAVE_DELAY_MS } = await import('./useSketchAutosave')
const { draftKey } = await import('./draft')

const stroke = (id: string): Stroke => ({ type: 'stroke', id, tool: 'pen', color: 'ink', width: 3, points: [0, 0, 0.5, 10, 10, 0.5] })
const drawing = (...ids: string[]): SketchData => ({ v: 1, layout: 'infinite', background: 'plain', pages: 1, items: ids.map(stroke) })

const doc = (over: Partial<DocumentContent> = {}, sketch: Partial<NonNullable<DocumentContent['sketch']>> = {}): DocumentContent => ({
  id: 'sk-1',
  path: 'documents/board.sketch.md',
  folder: '',
  title: 'Board',
  kind: 'sketch',
  word_count: 0,
  last_editor: 'user',
  updated_at: '2026-11-01T10:00:00Z',
  properties: {},
  content: '# Board\n',
  hash: 'h0',
  sketch: {
    data: drawing(),
    error: null,
    drawing_hash: 'd0',
    transcription: null,
    transcription_current: false,
    transcription_status: null,
    preview: { drawing_hash: 'd0', width: 10, height: 10 },
    preview_current: true,
    ...sketch,
  },
  ...over,
})

function setup(start: DocumentContent = doc()) {
  const client = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { client, ...renderHook(() => useSketchAutosave(start), { wrapper }) }
}

const afterSave = (data: SketchData, hash: string, drawingHash: string) =>
  doc({ hash }, { data, drawing_hash: drawingHash, preview_current: false })

describe('useSketchAutosave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    api.uploadPreview.mockResolvedValue({ drawing_hash: 'd1', width: 10, height: 10 })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('saves once a moment after the last change, on the version that was opened', async () => {
    const two = drawing('a', 'b')
    api.saveSketch.mockResolvedValue(afterSave(two, 'h1', 'd1'))
    const { result } = setup()
    act(() => result.current.change(drawing('a')))
    act(() => result.current.change(two))
    expect(result.current.state).toBe('unsaved')
    await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 100))
    expect(api.saveSketch).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(api.saveSketch).toHaveBeenCalledTimes(1)
    expect(api.saveSketch).toHaveBeenCalledWith('sk-1', two, 'h0', undefined)
    expect(result.current.state).toBe('saved')
    expect(result.current.baseHash()).toBe('h1')
  })

  it('sends a changed title with the drawing', async () => {
    api.saveSketch.mockResolvedValue(doc({ hash: 'h1', title: 'Plan' }))
    const { result } = setup()
    act(() => result.current.setTitle('Plan'))
    await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 50))
    expect(api.saveSketch).toHaveBeenCalledWith('sk-1', expect.objectContaining({ items: [] }), 'h0', 'Plan')
  })

  it('uploads the image of the saved drawing when the server has none of it', async () => {
    const one = drawing('a')
    api.saveSketch.mockResolvedValue(afterSave(one, 'h1', 'd1'))
    const { result, client } = setup()
    client.setQueryData(['document', 'sk-1'], doc())
    act(() => result.current.change(one))
    await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 50))
    expect(render).toHaveBeenCalledWith(one)
    expect(api.uploadPreview).toHaveBeenCalledWith('sk-1', expect.any(Blob), 'd1')
    // The open document knows its image is current now.
    expect(client.getQueryData<DocumentContent>(['document', 'sk-1'])?.sketch?.preview_current).toBe(true)
  })

  it('ignores an image that is out of date: a newer save brings its own', async () => {
    api.saveSketch.mockResolvedValue(afterSave(drawing('a'), 'h1', 'd1'))
    api.uploadPreview.mockRejectedValue(new ApiError(409, 'preview_outdated', 'changed'))
    const { result } = setup()
    act(() => result.current.change(drawing('a')))
    await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 50))
    expect(result.current.state).toBe('saved')
    expect(result.current.error).toBeNull()
  })

  it('draws the image once on opening when it is out of date (a restored version)', async () => {
    setup(doc({}, { preview_current: false }))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(api.uploadPreview).toHaveBeenCalledWith('sk-1', expect.any(Blob), 'd0')
  })

  it('stops on a conflict until the user chooses, then can write over the other version', async () => {
    api.saveSketch.mockRejectedValueOnce(new ApiError(409, 'conflict_base_hash', 'changed elsewhere'))
    // The other version has another drawing: a real conflict.
    api.fetchDocument.mockResolvedValue(doc({ hash: 'h9' }, { drawing_hash: 'd9' }))
    const { result } = setup()
    act(() => result.current.change(drawing('mine')))
    await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 50))
    expect(result.current.state).toBe('conflict')

    act(() => result.current.change(drawing('mine', 'more')))
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(api.saveSketch).toHaveBeenCalledTimes(1) // nothing is written while the choice is open

    api.saveSketch.mockResolvedValue(afterSave(drawing('mine', 'more'), 'h10', 'd10'))
    await act(async () => result.current.overwrite())
    expect(api.saveSketch).toHaveBeenLastCalledWith('sk-1', drawing('mine', 'more'), null, undefined)
    expect(result.current.state).toBe('saved')
  })

  it('saves on top of a change to only the words around the drawing (properties, transcription)', async () => {
    api.saveSketch.mockRejectedValueOnce(new ApiError(409, 'conflict_base_hash', 'changed elsewhere'))
    api.fetchDocument.mockResolvedValue(doc({ hash: 'h5' }, { drawing_hash: 'd0', transcription: 'Hello' }))
    api.saveSketch.mockResolvedValueOnce(afterSave(drawing('a'), 'h6', 'd1'))
    const { result } = setup()
    act(() => result.current.change(drawing('a')))
    await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 50))
    expect(api.saveSketch).toHaveBeenLastCalledWith('sk-1', drawing('a'), 'h5', undefined)
    expect(result.current.state).toBe('saved')
  })

  it('without a connection keeps the drawing on this device and tries again, also when back online', async () => {
    api.saveSketch.mockRejectedValue(new TypeError('Failed to fetch'))
    const { result } = setup()
    const one = drawing('a')
    act(() => result.current.change(one))
    expect(JSON.parse(localStorage.getItem(draftKey('sk-1'))!).data).toEqual(one)
    await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 50))
    expect(result.current.state).toBe('offline')
    expect(api.saveSketch).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(2100)) // the first retry
    expect(api.saveSketch).toHaveBeenCalledTimes(2)

    api.saveSketch.mockResolvedValue(afterSave(one, 'h1', 'd1'))
    await act(async () => {
      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(api.saveSketch).toHaveBeenCalledTimes(3)
    expect(result.current.state).toBe('saved')
    expect(localStorage.getItem(draftKey('sk-1'))).toBeNull() // the server has it now
  })

  it('starts from a drawing kept on this device and saves it, when the server still has the version it was drawn on', async () => {
    const kept = drawing('offline')
    localStorage.setItem(draftKey('sk-1'), JSON.stringify({ data: kept, title: null, baseHash: 'h0', at: Date.now() }))
    api.saveSketch.mockResolvedValue(afterSave(kept, 'h1', 'd1'))
    const { result } = setup()
    expect(result.current.initial).toEqual(kept)
    expect(result.current.state).toBe('unsaved')
    await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 50))
    expect(api.saveSketch).toHaveBeenCalledWith('sk-1', kept, 'h0', undefined)
  })

  it('offers the choice when the kept drawing is newer than a version changed elsewhere, and drops an older one', () => {
    const kept = drawing('offline')
    localStorage.setItem(draftKey('sk-1'), JSON.stringify({ data: kept, title: null, baseHash: 'old', at: Date.parse('2026-11-02T00:00:00Z') }))
    expect(setup().result.current.state).toBe('conflict')

    localStorage.setItem(draftKey('sk-1'), JSON.stringify({ data: kept, title: null, baseHash: 'old', at: Date.parse('2026-10-01T00:00:00Z') }))
    const { result } = setup()
    expect(result.current.state).toBe('saved')
    expect(result.current.initial).toEqual(drawing())
    expect(localStorage.getItem(draftKey('sk-1'))).toBeNull()
  })

  it('sends what is pending when the sketch is closed', async () => {
    api.saveSketch.mockResolvedValue(afterSave(drawing('a'), 'h1', 'd1'))
    const { result, unmount } = setup()
    act(() => result.current.change(drawing('a')))
    unmount()
    expect(api.saveSketch).toHaveBeenCalledWith('sk-1', drawing('a'), 'h0', undefined)
  })
})
