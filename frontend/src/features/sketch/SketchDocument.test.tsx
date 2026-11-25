import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { DocumentContent } from '@/features/documents/api'
import type { SketchData } from './model'

// The canvas is drawn by its own module (tested there); here it only shows what it got.
vi.mock('./canvas/SketchCanvas', () => ({
  SketchCanvas: ({ data }: { data: SketchData }) => <div data-testid="canvas">{data.items.length} items</div>,
}))
vi.mock('./canvas/preview', () => ({ renderPreview: async () => new Blob() }))
const sketchApi = vi.hoisted(() => ({ requestTranscription: vi.fn(async () => undefined), useTranscriptionPoll: vi.fn() }))
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), ...sketchApi }))
const preview = vi.hoisted(() => ({ ensurePreview: vi.fn(async () => undefined), sketchForChat: vi.fn(), uploadDrawing: vi.fn(async () => null) }))
vi.mock('./ensurePreview', () => preview)
// The documents' frame around it, without the server.
vi.mock('@/features/documents/useDocumentActions', () => ({
  useDocumentActions: () => ({ rename: vi.fn(), moveToFolder: vi.fn(), confirmDelete: vi.fn(), project: undefined, error: null }),
}))
vi.mock('@/features/documents/components/PropertiesBar', () => ({ PropertiesBar: () => null, showsProperties: () => false }))
vi.mock('@/features/documents/components/DocumentInfo', () => ({
  DocumentInfo: ({ first }: { first?: { content: ReactNode } }) => <div>{first?.content}</div>,
}))
vi.mock('@/features/links/DocumentBacklinks', () => ({ DocumentBacklinks: () => null }))
vi.mock('@/hooks/useMediaQuery', () => ({ DESKTOP: '', useMediaQuery: () => true }))

const { SketchSession } = await import('./SketchDocument')

type Sketch = NonNullable<DocumentContent['sketch']>
const data: SketchData = { v: 1, layout: 'infinite', background: 'plain', pages: 1, items: [] }
const doc = (sketch: Partial<Sketch> = {}): DocumentContent => ({
  id: 'sk-1', path: 'documents/board.sketch.md', folder: '', title: 'Board', kind: 'sketch', word_count: 0, last_editor: 'user',
  updated_at: '2026-11-01T10:00:00Z', properties: {}, content: '# Board\n', hash: 'h0',
  sketch: {
    data, error: null, drawing_hash: 'd0', transcription: null, transcription_current: false, transcription_status: null,
    preview: { drawing_hash: 'd0', width: 10, height: 10 }, preview_current: true, ...sketch,
  },
})

function NewChat() {
  const state = useLocation().state as { attachments: { id: string }[] }
  return <p>new chat with {state.attachments.map((a) => a.id).join(', ')}</p>
}

function show(d: DocumentContent) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/documents/sk-1']}>
        <Routes>
          <Route path="/documents/:id" element={<SketchSession doc={d} server={d} onServerChanged={vi.fn()} onLoadOther={vi.fn()} />} />
          <Route path="/" element={<NewChat />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('an open sketch', () => {
  it('shows its drawing on the canvas, with its title to edit', () => {
    show(doc({ data: { ...data, items: [{ type: 'stroke', id: 's1', tool: 'pen', color: 'ink', width: 2, points: [0, 0, 0.5] }] } }))
    expect(screen.getByTestId('canvas')).toHaveTextContent('1 items')
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Board')
  })

  it('says so when the drawing can’t be read, and offers the history instead of a canvas', () => {
    show(doc({ data: null, drawing_hash: null, error: 'The sketch block is not valid JSON' }))
    expect(screen.queryByTestId('canvas')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('The drawing in this file can’t be read')
    expect(screen.getByText('The sketch block is not valid JSON')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open the history' })).toBeInTheDocument()
  })

  it('asks for a transcription with a current image', async () => {
    show(doc())
    expect(screen.getByText(/A model that can see images can read the drawing/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Transcribe' }))
    expect(preview.ensurePreview).toHaveBeenCalledWith('sk-1', expect.anything())
    expect(sketchApi.requestTranscription).toHaveBeenCalledWith('sk-1')
  })

  it('shows a transcription that is queued', () => {
    show(doc({ transcription_status: 'queued' }))
    expect(screen.getByRole('status')).toHaveTextContent('Reading the drawing…')
    expect(sketchApi.useTranscriptionPoll).toHaveBeenLastCalledWith('sk-1', true)
  })

  it('shows the text read from the drawing as derived, and when it is out of date', () => {
    show(doc({ transcription: 'Buy <b>milk</b>', transcription_current: false }))
    expect(screen.getByText('Read from the drawing by a model')).toBeInTheDocument()
    expect(screen.getByText('Buy <b>milk</b>')).toBeInTheDocument() // as text, never as markup
    expect(screen.getByText('Made from an earlier version of the drawing.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Transcribe again' })).toBeInTheDocument()
  })

  it('shows a transcription that failed', () => {
    show(doc({ transcription_status: 'failed' }))
    expect(screen.getByRole('alert')).toHaveTextContent('The drawing could not be read')
  })

  it('opens a new chat with the sketch’s image attached', async () => {
    preview.sketchForChat.mockResolvedValue({ id: 'att-1', filename: 'board.png', mime: 'image/png', size: 10, kind: 'image', extraction_note: null })
    show(doc())
    await userEvent.click(screen.getAllByRole('button', { name: 'Ask about this sketch' })[0])
    expect(await screen.findByText('new chat with att-1')).toBeInTheDocument()
  })
})
