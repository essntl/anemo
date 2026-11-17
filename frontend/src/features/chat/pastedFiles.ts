/**
 * Files in a paste: screenshots, images copied from a page or an app, files copied in
 * a file manager. Browsers put them in `files`, some only in `items`. A pasted image
 * is usually called just "image.png"; it gets a name that tells pastes apart.
 */

const GENERIC = /^image\.(png|jpe?g|gif|webp|bmp|tiff?)$/i

function pastedName(file: File, now: Date, index: number): string {
  if (file.name && !GENERIC.test(file.name)) return file.name
  const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png'
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`
  return `Pasted image ${time}${index ? ` (${index + 1})` : ''}.${ext}`
}

function named(found: File[], now: Date): File[] {
  return found.map((file, i) => {
    const name = pastedName(file, now, i)
    return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified })
  })
}

/**
 * The files of a `paste` event's `clipboardData`, or of the `dataTransfer` of a
 * `beforeinput` with `inputType` "insertFromPaste" (how Chrome on Android can hand over
 * an image from the keyboard's clipboard). Chrome on Android often gives the image only
 * in `items`, with `files` empty.
 */
export function pastedFiles(data: DataTransfer | null | undefined, now = new Date()): File[] {
  if (!data) return []
  let found = Array.from(data.files ?? [])
  if (!found.length) {
    found = Array.from(data.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null)
  }
  return named(found, now)
}

/** Whether the browser can read images from the clipboard on request (the "Paste an image" button). */
export function canReadClipboard(clipboard: Clipboard | undefined = globalThis.navigator?.clipboard): boolean {
  return typeof clipboard?.read === 'function'
}

/**
 * The images on the clipboard, read through the Clipboard API (the browser asks for
 * permission the first time). For where a paste never reaches the page: Chrome on
 * Android offers no "Paste" for an image in a plain text box. Throws if reading is refused.
 */
export async function clipboardImages(clipboard: Clipboard = navigator.clipboard, now = new Date()): Promise<File[]> {
  const found: File[] = []
  for (const item of await clipboard.read()) {
    const type = item.types.find((ty) => ty.startsWith('image/'))
    if (!type) continue
    const blob = await item.getType(type)
    found.push(new File([blob], '', { type }))
  }
  return named(found, now)
}

/** Whether a paste there belongs to that field (an input, a text area, an editor). */
export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'checkbox')
}
