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

export function pastedFiles(data: DataTransfer | null, now = new Date()): File[] {
  if (!data) return []
  let found = Array.from(data.files ?? [])
  if (!found.length) {
    found = Array.from(data.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null)
  }
  return found.map((file, i) => {
    const name = pastedName(file, now, i)
    return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified })
  })
}

/** Whether a paste there belongs to that field (an input, a text area, an editor). */
export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'checkbox')
}
