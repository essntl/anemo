import { describe, expect, it } from 'vitest'
import { pastedFiles } from './pastedFiles'

const at = new Date(2026, 10, 7, 9, 5, 3)

function transfer(files: File[], { itemsOnly = false } = {}): DataTransfer {
  return {
    files: itemsOnly ? [] : files,
    items: files.map((f) => ({ kind: 'file', getAsFile: () => f })),
  } as unknown as DataTransfer
}

describe('pastedFiles', () => {
  it('names a pasted screenshot so pastes can be told apart', () => {
    const [a, b] = pastedFiles(transfer([new File(['x'], 'image.png', { type: 'image/png' }), new File(['y'], 'image.png', { type: 'image/png' })]), at)
    expect([a.name, b.name]).toEqual(['Pasted image 09.05.03.png', 'Pasted image 09.05.03 (2).png'])
    expect(a.type).toBe('image/png')
  })

  it('keeps the names of copied files and reads files given only as items', () => {
    const report = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' })
    expect(pastedFiles(transfer([report]), at)).toEqual([report])
    const shot = new File(['x'], '', { type: 'image/jpeg' })
    expect(pastedFiles(transfer([shot], { itemsOnly: true }), at).map((f) => f.name)).toEqual(['Pasted image 09.05.03.jpg'])
  })

  it('finds nothing in a text paste', () => {
    expect(pastedFiles({ files: [], items: [{ kind: 'string', getAsFile: () => null }] } as unknown as DataTransfer)).toEqual([])
    expect(pastedFiles(null)).toEqual([])
  })
})
