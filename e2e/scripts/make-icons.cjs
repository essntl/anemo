// Generates the app icons from one SVG definition. Usage (from e2e/): node scripts/make-icons.cjs ../frontend/public
const fs = require('fs')
const path = require('path')
const { chromium } = require('@playwright/test')
const out = process.argv[2]
const ACCENT = '#3478f6'
// lucide "bot" glyph (24x24 grid), drawn white.
const glyph = `<g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></g>`
// rounded: app icon with its own corners; full: edge-to-edge square (maskable / Apple).
const svg = (kind) => {
  const scale = kind === 'maskable' ? 0.42 : 0.6 // maskable keeps the glyph inside the 80% safe circle
  const size = 24 * scale
  const offset = (24 - size) / 2
  const bg = kind === 'rounded'
    ? `<rect width="24" height="24" rx="5.5" fill="${ACCENT}"/>`
    : `<rect width="24" height="24" fill="${ACCENT}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${bg}<g transform="translate(${offset} ${offset}) scale(${scale})">${glyph}</g></svg>`
}
;(async () => {
  fs.mkdirSync(path.join(out, 'icons'), { recursive: true })
  fs.writeFileSync(path.join(out, 'favicon.svg'), svg('rounded') + '\n')
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const shots = [
    ['icons/icon-192.png', 'rounded', 192],
    ['icons/icon-512.png', 'rounded', 512],
    ['icons/icon-maskable-512.png', 'maskable', 512],
    ['icons/apple-touch-icon.png', 'full', 180],
  ]
  for (const [file, kind, px] of shots) {
    await page.setViewportSize({ width: px, height: px })
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg(kind).replace('<svg ', `<svg width="${px}" height="${px}" `)}</body></html>`)
    await page.screenshot({ path: path.join(out, file), omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } })
  }
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })
