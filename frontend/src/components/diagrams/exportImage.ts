/** Downloading a drawing as SVG or PNG. */

/** A file name from the chart's title (or a default), e.g. "visitors-per-day". */
export function fileName(title: string | undefined, fallback: string, ext: 'svg' | 'png'): string {
  const base = (title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${base || fallback}.${ext}`
}

/**
 * The drawing as a standalone SVG file: with its namespace, a fixed size, a background
 * and without the hover tooltip.
 */
export function svgFile(svg: SVGSVGElement, background: string): { markup: string; width: number; height: number } {
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const box = svg.viewBox?.baseVal
  const rect = svg.getBoundingClientRect()
  const width = Math.round(box?.width || rect.width || 640)
  const height = Math.round(box?.height || rect.height || 320)
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  clone.style.removeProperty('max-width')
  clone.querySelectorAll('[data-testid="chart-tooltip"]').forEach((n) => n.remove())
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bg.setAttribute('x', String(box?.x ?? 0))
  bg.setAttribute('y', String(box?.y ?? 0))
  bg.setAttribute('width', String(width))
  bg.setAttribute('height', String(height))
  bg.setAttribute('fill', background)
  clone.insertBefore(bg, clone.firstChild)
  return { markup: new XMLSerializer().serializeToString(clone), width, height }
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadSvg(svg: SVGSVGElement, background: string, name: string): void {
  const { markup } = svgFile(svg, background)
  download(new Blob([markup], { type: 'image/svg+xml' }), name)
}

/** Draws the SVG onto a canvas at twice its size and saves that as a PNG. */
export async function downloadPng(svg: SVGSVGElement, background: string, name: string): Promise<void> {
  const { markup, width, height } = svgFile(svg, background)
  const image = new Image()
  image.decoding = 'async'
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('The picture could not be made'))
  })
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
  await loaded
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('The picture could not be made')
  ctx.fillStyle = background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('The picture could not be made')
  download(blob, name)
}
