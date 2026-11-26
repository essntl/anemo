/**
 * `ui.pickFile`: Anemo's page opens the browser's own file picker for a plugin frame and
 * hands back the one picture the user chose, as a data: URL. The frame can't open a
 * picker itself (its sandbox has no file access), and nothing is read that the user
 * didn't choose, so this needs no permission. Images only in v1, at most 10 MB.
 *
 * The picker must follow a click: browsers only open it with "user activation", and a
 * click inside the frame gives the page that activation too. Without one the call is
 * refused (`permission_denied`) instead of a picker that silently never opens.
 */

export const PICKABLE_TYPES = ['image/png', 'image/webp', 'image/gif', 'image/jpeg'] as const
export const MAX_PICK_BYTES = 10 * 1024 * 1024

export interface PickOptions {
  accept: string[]
  maxBytes: number
}

export interface PickedFile {
  name: string
  type: string
  size: number
  dataUrl: string
}

/** Why picking failed: the user cancelled (`declined`), or the file can't be used. */
export class PickError extends Error {
  readonly code: 'declined' | 'invalid_params' | 'permission_denied'
  constructor(code: PickError['code'], message: string) {
    super(message)
    this.code = code
  }
}

/** The picture type of the file's first bytes, or null when it isn't one of PICKABLE_TYPES. */
export function sniffImage(bytes: Uint8Array): string | null {
  const at = (offset: number, ...values: number[]) => values.every((v, i) => bytes[offset + i] === v)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return null
}

/** Whether the page has a fresh user activation (a click, a key); true where the browser can't say. */
export function hasUserActivation(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
  return activation ? activation.isActive : true
}

let picking = false

/** Reads a chosen file, checked by its content. */
export async function readPicked(file: File, options: PickOptions): Promise<PickedFile> {
  if (file.size > options.maxBytes) throw new PickError('invalid_params', `The file is larger than ${options.maxBytes} bytes.`)
  const type = sniffImage(new Uint8Array(await file.slice(0, 16).arrayBuffer()))
  if (!type || !options.accept.includes(type)) throw new PickError('invalid_params', `The file isn't one of ${options.accept.join(', ')}.`)
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new PickError('invalid_params', 'The file could not be read.'))
    reader.readAsDataURL(file)
  })
  // The browser names the type by the file's extension: use the one its content has.
  const comma = dataUrl.indexOf(',')
  return { name: file.name.slice(0, 200), type, size: file.size, dataUrl: `data:${type};base64,${dataUrl.slice(comma + 1)}` }
}

/** Opens the browser's file picker; resolves with the picture, rejects with a PickError. */
export function pickFile(options: PickOptions): Promise<PickedFile> {
  if (picking) return Promise.reject(new PickError('declined', 'A file picker is open already.'))
  if (!hasUserActivation()) return Promise.reject(new PickError('permission_denied', 'ui.pickFile must be called right after a click in the frame.'))
  picking = true
  return new Promise<PickedFile>((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = options.accept.join(',')
    input.style.display = 'none'
    let done = false
    const finish = () => {
      done = true
      picking = false
      window.removeEventListener('focus', onFocus)
      input.remove()
    }
    input.addEventListener('change', () => {
      if (done) return
      const file = input.files?.[0]
      finish()
      if (!file) return reject(new PickError('declined', 'No file was chosen.'))
      readPicked(file, options).then(resolve, reject)
    })
    input.addEventListener('cancel', () => {
      if (done) return
      finish()
      reject(new PickError('declined', 'No file was chosen.'))
    })
    // Browsers without the cancel event: the window gets the focus back without a change.
    const onFocus = () =>
      window.setTimeout(() => {
        if (done || input.files?.length) return
        finish()
        reject(new PickError('declined', 'No file was chosen.'))
      }, 1000)
    window.addEventListener('focus', onFocus)
    document.body.appendChild(input)
    input.click()
  })
}
