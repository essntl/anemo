// The Anemo mark for the icon scripts (make-icons.cjs: web app; make-native-icons.cjs: Windows and
// Android). The same shapes as frontend/src/components/ui/Logo.tsx: change both together.

// A neutral dark tile: the icon looks the same whatever accent colour is chosen in the app.
const TILE = '#15181e'

// The three strokes on a 24x24 grid, drawn with round caps and joins, moved by MARK_OFFSET.
const MARK_PATHS = ['M5 8h7.5a2.5 2.5 0 1 0-2.5-2.5', 'M1.5 12h16a3 3 0 1 1-3 3', 'M4 16h6.5']
const MARK_OFFSET = [0.75, 1.5]
const MARK_STROKE = 1.7

// The fade runs from x=1 (transparent, or `from`) to x=13 (opaque), in the mark's own coordinates.
const FADE = { x1: 1, x2: 13 }

/** The mark as SVG (a <defs> with its gradient and a <g>), white by default, fading in from the left. */
function markSvg({ id = 'fade', color = '#fff', from = 0, stroke = MARK_STROKE, fade = true } = {}) {
  const paint = fade ? `url(#${id})` : color
  const defs = fade
    ? `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${FADE.x1}" y1="0" x2="${FADE.x2}" y2="0">
<stop offset="0" stop-color="${color}" stop-opacity="${from}"/><stop offset="1" stop-color="${color}"/></linearGradient></defs>
`
    : ''
  return `${defs}<g fill="none" stroke="${paint}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" transform="translate(${MARK_OFFSET.join(' ')})">
${MARK_PATHS.map((d) => `<path d="${d}"/>`).join('')}</g>`
}

module.exports = { TILE, MARK_PATHS, MARK_OFFSET, MARK_STROKE, FADE, markSvg }
