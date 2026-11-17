/**
 * Uploading many files, or whole folders, into Files.
 *
 * Every file goes up in its own request (a few at a time): one request with the whole
 * batch runs into the size limit of a proxy in front of the app (Cloudflare takes 100 MB)
 * and one bad file used to fail all the others. A folder keeps its structure: each file
 * is sent with its path inside the folder and the server makes the folders on the way.
 */
import { ApiError, type Schemas } from '@/api/client'
import { plural, t } from '@/lib/i18n'

type Entry = Schemas['EntryOut']

/** A file to upload and where it goes inside the chosen folder ("photos/2024/a.jpg"). */
export interface UploadItem {
  file: File
  path: string
}

export interface UploadFailure {
  path: string
  message: string
}

export interface UploadResult {
  saved: Entry[]
  failed: UploadFailure[]
}

export interface UploadProgress {
  done: number
  total: number
}

/** Files from a file input: with their folders when it picked a folder (`webkitdirectory`). */
export function itemsFromFiles(files: FileList | File[]): UploadItem[] {
  return Array.from(files).map((file) => ({ file, path: file.webkitRelativePath || file.name }))
}

/** Whether this browser has a folder picker (`<input webkitdirectory>`). */
export function canPickFolders(): boolean {
  return typeof document !== 'undefined' && 'webkitdirectory' in document.createElement('input')
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject))
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

async function walk(entry: FileSystemEntry, prefix: string, out: UploadItem[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isFile) {
    out.push({ file: await entryFile(entry as FileSystemFileEntry), path })
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    // readEntries gives a folder's contents in parts (100 at a time in Chrome) until it gives none.
    for (;;) {
      const part = await readEntries(reader)
      if (!part.length) break
      for (const child of part) await walk(child, path, out)
    }
  }
}

/**
 * The files of a drop, with folders walked. Call it in the drop handler itself: the
 * browser empties the drop's data once the handler returns, so the entries are taken at
 * once and read afterwards.
 */
export function itemsFromDrop(data: DataTransfer): Promise<UploadItem[]> {
  const entries = Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.() ?? null)
  if (!entries.length || entries.some((e) => e === null)) {
    // No entries (an old browser, or a test): the plain files. A dropped folder shows up
    // here as a file that can't be read, so leave out what has no type and no size.
    return Promise.resolve(itemsFromFiles(Array.from(data.files).filter((f) => f.type || f.size)))
  }
  return (async () => {
    const out: UploadItem[] = []
    for (const entry of entries) await walk(entry!, '', out)
    return out
  })()
}

async function sendOne(folder: string, item: UploadItem): Promise<Entry[]> {
  const form = new FormData()
  form.append('folder', folder)
  form.append('files', item.file, item.file.name)
  if (item.path !== item.file.name) form.append('paths', item.path)
  let res: Response
  try {
    res = await fetch('/api/files/upload', { method: 'POST', body: form, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'network', t('The connection failed'))
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
  if (!res.ok) {
    const message = body.error?.message
      ?? (res.status === 413 ? t('Too large for the server (or a proxy in front of it)') : t('Upload failed'))
    throw new ApiError(res.status, body.error?.code ?? `http_${res.status}`, message)
  }
  return body as unknown as Entry[]
}

/**
 * Upload every item into `folder`, `concurrency` at a time, carrying on past a file
 * that fails. Never throws: what failed is in the result.
 */
export async function uploadAll(
  folder: string,
  items: UploadItem[],
  { onProgress, concurrency = 3, send = sendOne }: {
    onProgress?: (p: UploadProgress) => void
    concurrency?: number
    send?: (folder: string, item: UploadItem) => Promise<Entry[]>
  } = {},
): Promise<UploadResult> {
  const saved: (Entry[] | undefined)[] = new Array(items.length)
  const failed: UploadFailure[] = []
  let next = 0
  let done = 0
  onProgress?.({ done, total: items.length })
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      try {
        saved[i] = await send(folder, items[i])
      } catch (err) {
        failed.push({ path: items[i].path, message: err instanceof Error ? err.message : t('Upload failed') })
      }
      onProgress?.({ done: ++done, total: items.length })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return { saved: saved.flatMap((s) => s ?? []), failed }
}

/** One line about what didn't upload, for a toast or the error bar. */
export function failureSummary(result: UploadResult): string {
  const total = result.saved.length + result.failed.length
  const first = result.failed[0]
  if (!first) return ''
  const detail = `${first.path}: ${first.message}`
  if (result.failed.length === 1 && total === 1) return detail
  return plural(total, '{failed} of {n} file was not uploaded. {detail}', '{failed} of {n} files were not uploaded. {detail}', { failed: result.failed.length, detail })
}
