// Generates the app icons from one SVG definition. Usage (from e2e/): node scripts/make-icons.cjs ../frontend/public
const fs = require('fs')
const path = require('path')
const { chromium } = require('@playwright/test')
const out = process.argv[2]
// A neutral dark tile: the icon looks the same whatever accent colour is chosen in the app.
const TILE = '#15181e'
// The wind mark (24x24 grid), white, fading in from the left.
// The same shapes as frontend/src/components/ui/Logo.tsx: change both together.
const glyph = `<defs><linearGradient id="fade" gradientUnits="userSpaceOnUse" x1="1" y1="0" x2="13" y2="0">
<stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>
<g fill="none" stroke="url(#fade)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" transform="translate(0.75 1.5)">
<path d="M5 8h7.5a2.5 2.5 0 1 0-2.5-2.5"/><path d="M1.5 12h16a3 3 0 1 1-3 3"/><path d="M4 16h6.5"/></g>`
// rounded: app icon with its own corners; full: edge-to-edge square (maskable / Apple).
const svg = (kind) => {
  const scale = kind === 'maskable' ? 0.46 : 0.64 // maskable keeps the glyph inside the 80% safe circle
  const size = 24 * scale
  const offset = (24 - size) / 2
  const bg = kind === 'rounded'
    ? `<rect width="24" height="24" rx="5.5" fill="${TILE}"/>`
    : `<rect width="24" height="24" fill="${TILE}"/>`
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
