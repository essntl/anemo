// Generates the icons of the native apps from the Anemo mark (icon-shapes.cjs):
//   Anemo Desktop (Windows): the app icon and the five tray icons, as multi-size .ico files;
//   Anemo Voice (Android): the adaptive launcher icon (foreground, monochrome, background colour)
//   and the notification icon, as vector drawables (minSdk 29, so no PNG mipmaps are needed).
// Usage (from e2e/, after npm ci): node scripts/make-native-icons.cjs
// It renders with Playwright's Chromium, or with Microsoft Edge when Chromium isn't installed.
const fs = require('fs')
const path = require('path')
const { chromium } = require('@playwright/test')
const { TILE, MARK_PATHS, MARK_OFFSET, MARK_STROKE, FADE, markSvg } = require('./icon-shapes.cjs')

const repo = path.resolve(__dirname, '..', '..')
const desktopAssets = path.join(repo, 'desktop', 'src', 'Anemo.Desktop', 'Assets')
const androidRes = path.join(repo, 'android', 'app', 'src', 'main', 'res')

// ---- Windows ---------------------------------------------------------------------------------

// Up to 32 px the mark is drawn bigger and heavier and its tails start at 35 % so they stay visible.
const REGULAR = { scale: 0.64, stroke: MARK_STROKE, from: 0, rx: 5.5 }
const SMALL = { scale: 0.8, stroke: 2.3, from: 0.35, rx: 4.5 }

// The tray states (TrayIcon in Anemo.Desktop.Core/TrayStatus.cs): a tile colour and an optional badge.
const GREY = '#868c97'
const RED = '#dc3b3b'
const AMBER = '#f2a93b'
const BADGE_INK = '#1a1204'
const TRAY = {
  Normal: { tile: TILE }, // connected
  Grey: { tile: GREY }, // connecting, or lost and trying again
  Red: { tile: RED }, // the agent is acting on this computer
  Paused: { tile: TILE, badge: 'pause' }, // connected, control paused
  Problem: { tile: GREY, badge: 'warn' }, // not set up, or refused: open Settings
}
const APP_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
const TRAY_SIZES = [16, 20, 24, 32, 40, 48] // NotifyIcon asks for SystemInformation.SmallIconSize

/** A tile with the mark and an optional badge cut out of its bottom-right corner (24x24 grid). */
function tileSvg(size, { tile, badge } = {}) {
  const v = size <= 32 ? SMALL : REGULAR
  const offset = (24 - 24 * v.scale) / 2
  const body = `<rect width="24" height="24" rx="${v.rx}" fill="${tile || TILE}"/>
<g transform="translate(${offset} ${offset}) scale(${v.scale})">${markSvg({ id: 'f', from: v.from, stroke: v.stroke })}</g>`
  if (!badge) return svgDoc(size, body)
  // The badge sits in a transparent ring, so it reads on any taskbar colour.
  const mark =
    badge === 'pause'
      ? `<rect x="17.6" y="16.7" width="1.3" height="4.6" rx="0.4" fill="${BADGE_INK}"/><rect x="19.9" y="16.7" width="1.3" height="4.6" rx="0.4" fill="${BADGE_INK}"/>`
      : `<rect x="18.75" y="15.9" width="1.3" height="3.7" rx="0.6" fill="${BADGE_INK}"/><circle cx="19.4" cy="21.2" r="0.8" fill="${BADGE_INK}"/>`
  return svgDoc(
    size,
    `<defs><mask id="cut"><rect width="24" height="24" fill="#fff"/><circle cx="19.4" cy="19" r="6.4" fill="#000"/></mask></defs>
<g mask="url(#cut)">${body}</g><circle cx="19.4" cy="19" r="5.6" fill="${AMBER}"/>${mark}`,
  )
}

const svgDoc = (size, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">${inner}</svg>`

/** An .ico of 32-bit images: BMP for the small sizes (every reader takes them), PNG for 256. */
function ico(images) {
  const parts = images.map(({ size, rgba, png }) => (size >= 256 ? png : dib(size, rgba)))
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // icon
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size }, i) => {
    const e = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, e)
    header.writeUInt8(size >= 256 ? 0 : size, e + 1)
    header.writeUInt16LE(1, e + 4) // planes
    header.writeUInt16LE(32, e + 6) // bits per pixel
    header.writeUInt32LE(parts[i].length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += parts[i].length
  })
  return Buffer.concat([header, ...parts])
}

/** A BITMAPINFOHEADER image: BGRA rows bottom-up, then an empty AND mask (the alpha is used). */
function dib(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4
  const head = Buffer.alloc(40)
  head.writeUInt32LE(40, 0)
  head.writeInt32LE(size, 4)
  head.writeInt32LE(size * 2, 8) // colour rows plus mask rows
  head.writeUInt16LE(1, 12)
  head.writeUInt16LE(32, 14)
  head.writeUInt32LE(size * size * 4 + maskRow * size, 20)
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4
      const to = ((size - 1 - y) * size + x) * 4
      pixels[to] = rgba[from + 2]
      pixels[to + 1] = rgba[from + 1]
      pixels[to + 2] = rgba[from]
      pixels[to + 3] = rgba[from + 3]
    }
  }
  return Buffer.concat([head, pixels, Buffer.alloc(maskRow * size)])
}

// ---- Android ---------------------------------------------------------------------------------

const ANDROID_NS = 'xmlns:android="http://schemas.android.com/apk/res/android"'

/** The mark as a vector drawable on a 24-unit viewport, scaled around the centre. */
function vector({ dp, scale, stroke, fade, comment }) {
  const offset = +((24 - 24 * scale) / 2).toFixed(3)
  const paint = fade
    ? `
            <aapt:attr name="android:strokeColor">
                <gradient
                    android:type="linear"
                    android:startX="${FADE.x1}"
                    android:startY="0"
                    android:endX="${FADE.x2}"
                    android:endY="0"
                    android:startColor="#00FFFFFF"
                    android:endColor="#FFFFFFFF" />
            </aapt:attr>`
    : ''
  const paths = MARK_PATHS.map((d) => {
    const attrs = `
            android:pathData="${d}"${fade ? '' : '\n            android:strokeColor="#FFFFFFFF"'}
            android:strokeWidth="${stroke}"
            android:strokeLineCap="round"
            android:strokeLineJoin="round"`
    return fade ? `\n        <path${attrs}>${paint}\n        </path>` : `\n        <path${attrs} />`
  }).join('')
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${comment} Generated by e2e/scripts/make-native-icons.cjs: edit that, not this. -->
<vector ${ANDROID_NS}${fade ? '\n    xmlns:aapt="http://schemas.android.com/aapt"' : ''}
    android:width="${dp}dp"
    android:height="${dp}dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <group
        android:translateX="${+(offset + MARK_OFFSET[0] * scale).toFixed(3)}"
        android:translateY="${+(offset + MARK_OFFSET[1] * scale).toFixed(3)}"
        android:scaleX="${scale}"
        android:scaleY="${scale}">${paths}
    </group>
</vector>
`
}

function android() {
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(androidRes, rel)), { recursive: true })
    fs.writeFileSync(path.join(androidRes, rel), text)
  }
  // The launcher layers are 108 dp; the mark stays inside the 66 dp safe zone.
  write('drawable/ic_launcher_foreground.xml', vector({ dp: 108, scale: 0.5, stroke: MARK_STROKE, fade: true, comment: 'The Anemo mark, white, fading in from the left.' }))
  write('drawable/ic_launcher_monochrome.xml', vector({ dp: 108, scale: 0.5, stroke: 2, fade: false, comment: 'The Anemo mark for themed icons: solid, no fade.' }))
  // Android draws only the alpha of a notification icon: solid and heavier so the tails survive 24 dp.
  write('drawable/ic_notification.xml', vector({ dp: 24, scale: 0.9, stroke: 2.2, fade: false, comment: 'The Anemo mark as a notification and tile icon.' }))
  write(
    'mipmap-anydpi-v26/ic_launcher.xml',
    `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by e2e/scripts/make-native-icons.cjs: edit that, not this. -->
<adaptive-icon ${ANDROID_NS}>
    <background android:drawable="@color/launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
`,
  )
  const colors = path.join(androidRes, 'values', 'colors.xml')
  const text = fs.readFileSync(colors, 'utf8')
  const next = text.replace(/(<color name="launcher_background">)#[0-9A-Fa-f]{6}(<\/color>)/, `$1${TILE.toUpperCase()}$2`)
  if (!next.includes(TILE.toUpperCase())) throw new Error('launcher_background not found in values/colors.xml')
  fs.writeFileSync(colors, next)
}

// ---- Rendering -------------------------------------------------------------------------------

async function launch() {
  try {
    return await chromium.launch()
  } catch {
    return await chromium.launch({ channel: 'msedge' })
  }
}

/** Renders an SVG at its own size; returns straight-alpha RGBA and a PNG. */
async function render(page, svg, size) {
  const { rgba, png } = await page.evaluate(
    async ({ svg, size }) => {
      const img = new Image()
      img.src = 'data:image/svg+xml;base64,' + btoa(svg)
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      const g = canvas.getContext('2d')
      g.drawImage(img, 0, 0, size, size)
      const data = g.getImageData(0, 0, size, size).data
      let bin = ''
      for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i])
      return { rgba: btoa(bin), png: canvas.toDataURL('image/png').split(',')[1] }
    },
    { svg, size },
  )
  return { size, rgba: Buffer.from(rgba, 'base64'), png: Buffer.from(png, 'base64') }
}

;(async () => {
  android()
  const browser = await launch()
  const page = await browser.newPage()
  await page.setContent('<html><body></body></html>')
  fs.mkdirSync(path.join(desktopAssets, 'Tray'), { recursive: true })
  const app = []
  for (const size of APP_SIZES) app.push(await render(page, tileSvg(size), size))
  fs.writeFileSync(path.join(desktopAssets, 'Anemo.ico'), ico(app))
  for (const [name, state] of Object.entries(TRAY)) {
    const images = []
    for (const size of TRAY_SIZES) images.push(await render(page, tileSvg(size, state), size))
    fs.writeFileSync(path.join(desktopAssets, 'Tray', `${name}.ico`), ico(images))
  }
  // Previews for review, not used by the apps.
  if (process.env.ICON_PREVIEW) {
    const dir = process.env.ICON_PREVIEW
    fs.mkdirSync(dir, { recursive: true })
    for (const [name, state] of Object.entries(TRAY)) {
      for (const size of [16, 32]) fs.writeFileSync(path.join(dir, `tray-${name}-${size}.png`), (await render(page, tileSvg(size, state), size)).png)
    }
    fs.writeFileSync(path.join(dir, 'app-256.png'), app[app.length - 1].png)
  }
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
