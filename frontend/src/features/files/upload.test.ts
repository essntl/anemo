import { afterEach, describe, expect, it, vi } from 'vitest'
import { failureSummary, itemsFromDrop, itemsFromFiles, type UploadItem, uploadAll } from './upload'

const file = (name: string, body = 'x', type = 'text/plain') => new File([body], name, { type })

/** A dropped file or folder as `webkitGetAsEntry` gives it. A folder lists its children `pageSize` at a time. */
function fileEntry(f: File): FileSystemFileEntry {
  return { isFile: true, isDirectory: false, name: f.name, file: (ok: (f: File) => void) => ok(f) } as unknown as FileSystemFileEntry
}
function dirEntry(name: string, children: FileSystemEntry[], pageSize = 2): FileSystemDirectoryEntry {
  return {
    isFile: false, isDirectory: true, name,
    createReader: () => {
      let at = 0
      return {
        readEntries: (ok: (e: FileSystemEntry[]) => void) => {
          const part = children.slice(at, at + pageSize)
          at += pageSize
          setTimeout(() => ok(part), 0)
        },
      }
    },
  } as unknown as FileSystemDirectoryEntry
}
function drop(entries: (FileSystemEntry | null)[], files: File[] = []): DataTransfer {
  return {
    items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
    files,
  } as unknown as DataTransfer
}

const entry = (path: string) => ({ name: path.split('/').pop()!, path, is_dir: false, size: 1, modified: '', mime: null })

afterEach(() => vi.unstubAllGlobals())

describe('the files of a drop', () => {
  it('walks dropped folders, keeping their structure, past the first part of a big folder', async () => {
    const tree = dirEntry('photos', [
      fileEntry(file('a.jpg')),
      dirEntry('2024', [fileEntry(file('b.jpg')), fileEntry(file('c.jpg')), fileEntry(file('d.jpg'))]),
      fileEntry(file('e.jpg')),
    ])
    const items = await itemsFromDrop(drop([tree, fileEntry(file('loose.txt'))]))
    expect(items.map((i) => i.path)).toEqual([
      'photos/a.jpg', 'photos/2024/b.jpg', 'photos/2024/c.jpg', 'photos/2024/d.jpg', 'photos/e.jpg', 'loose.txt',
    ])
  })

  it('without entries, takes the files and leaves out a folder (no type, no size)', async () => {
    const real = file('notes.md')
    const folder = new File([], 'photos', { type: '' })
    const items = await itemsFromDrop(drop([null, null], [real, folder]))
    expect(items).toEqual([{ file: real, path: 'notes.md' }])
  })

  it('uses the path inside a picked folder', () => {
    const f = file('a.jpg')
    Object.defineProperty(f, 'webkitRelativePath', { value: 'photos/2024/a.jpg' })
    expect(itemsFromFiles([f, file('b.txt')]).map((i) => i.path)).toEqual(['photos/2024/a.jpg', 'b.txt'])
  })
})

describe('uploading many files', () => {
  it('sends one file per request and carries on past one that fails', async () => {
    const items: UploadItem[] = ['a.txt', 'bad.txt', 'c.txt', 'd.txt'].map((n) => ({ file: file(n), path: `dir/${n}` }))
    const send = vi.fn(async (_folder: string, item: UploadItem) => {
      if (item.path === 'dir/bad.txt') throw new Error('Not allowed')
      return [entry(`docs/${item.path}`)]
    })
    const progress: number[] = []
    const result = await uploadAll('docs', items, { send, concurrency: 2, onProgress: (p) => progress.push(p.done) })
    expect(send).toHaveBeenCalledTimes(4)
    expect(result.saved.map((e) => e.path)).toEqual(['docs/dir/a.txt', 'docs/dir/c.txt', 'docs/dir/d.txt'])
    expect(result.failed).toEqual([{ path: 'dir/bad.txt', message: 'Not allowed' }])
    expect(progress).toEqual([0, 1, 2, 3, 4])
    expect(failureSummary(result)).toBe('1 of 4 files were not uploaded. dir/bad.txt: Not allowed')
  })

  it('posts the path inside the folder, and explains a 413 from a proxy', async () => {
    const bodies: FormData[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData
      bodies.push(form)
      if ((form.get('files') as File).name === 'huge.bin') return new Response('<html>413</html>', { status: 413 })
      return new Response(JSON.stringify([entry('x')]), { status: 201 })
    }))
    const result = await uploadAll('docs', [
      { file: file('a.jpg'), path: 'photos/a.jpg' },
      { file: file('b.txt'), path: 'b.txt' },
      { file: file('huge.bin'), path: 'huge.bin' },
    ], { concurrency: 1 })
    expect(bodies.map((b) => [b.get('folder'), (b.get('files') as File).name, b.getAll('paths')])).toEqual([
      ['docs', 'a.jpg', ['photos/a.jpg']],
      ['docs', 'b.txt', []],
      ['docs', 'huge.bin', []],
    ])
    expect(result.failed).toEqual([{ path: 'huge.bin', message: 'Too large for the server (or a proxy in front of it)' }])
  })
})
