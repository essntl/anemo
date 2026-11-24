/**
 * The animated backgrounds: soft colour spots drifting slowly (`.app-gradient` in
 * styles/appearance.css). "Aurora" is made from your accent colour, "Dusk" and "Lagoon"
 * have colours of their own, and "Custom" is yours: 2–4 colours, drifting spots or
 * sliding bands, an angle and a speed.
 */
import type { CSSProperties } from 'react'
import { mix } from '@/lib/color'
import { msg } from '@/lib/i18n'
import type { Background, CustomGradient } from './apply'

export type GradientId = Background['gradient']
export type PresetId = Exclude<GradientId, 'custom'>

export const GRADIENTS: { id: PresetId; label: string }[] = [
  { id: 'aurora', label: msg('Aurora') },
  { id: 'dusk', label: msg('Dusk') },
  { id: 'lagoon', label: msg('Lagoon') },
]

/** Seconds for one sweep of the drift (it then goes back the same way). */
export const SPEED_SECONDS: Record<CustomGradient['speed'], number> = { slow: 90, normal: 48, fast: 20 }

/**
 * Where the spots of a drifting custom gradient sit (% of the layer), at the default
 * angle (135°). Another angle turns these points around the middle.
 */
const SPOTS: [number, number][] = [[25, 30], [75, 25], [55, 75], [20, 80]]
const DEFAULT_ANGLE = 135

export function spotPositions(angle: number): string[] {
  const turn = ((angle - DEFAULT_ANGLE) * Math.PI) / 180
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)]
  return SPOTS.map(([x, y]) => {
    const [dx, dy] = [x - 50, y - 50]
    const round = (v: number) => Math.round(v * 10) / 10
    return `${round(50 + dx * cos - dy * sin)}% ${round(50 + dx * sin + dy * cos)}%`
  })
}

/** The three colours of a built-in gradient. */
export function gradientColors(id: PresetId, accent: string): [string, string, string] {
  switch (id) {
    case 'dusk':
      return ['#ff7e5f', '#feb47b', '#7b4397']
    case 'lagoon':
      return ['#00c9a7', '#0081cf', '#845ec2']
    default:
      return [accent, mix(accent, '#00d4ff', 0.55), mix(accent, '#ff4fd8', 0.55)]
  }
}

/** The colours a background gradient shows (a preset's, or the custom ones). */
export function colorsOf(background: Pick<Background, 'gradient' | 'custom_gradient'>, accent: string): string[] {
  return background.gradient === 'custom' ? background.custom_gradient.colors : gradientColors(background.gradient, accent)
}

/**
 * What `.app-gradient` needs: the colours as --g1…--g4, and for a custom gradient its
 * style, angle, speed and the stops of the linear style.
 */
export function gradientLayer(background: Pick<Background, 'gradient' | 'custom_gradient'>, accent: string): {
  style: CSSProperties
  dataStyle?: CustomGradient['style']
} {
  const colors = colorsOf(background, accent)
  const vars: Record<string, string> = {}
  colors.forEach((c, i) => (vars[`--g${i + 1}`] = c))
  if (background.gradient !== 'custom') return { style: vars as CSSProperties }
  const custom = background.custom_gradient
  vars['--g-angle'] = `${custom.angle}deg`
  vars['--g-duration'] = `${SPEED_SECONDS[custom.speed]}s`
  vars['--g-stops'] = colors.join(', ')
  spotPositions(custom.angle).forEach((at, i) => (vars[`--p${i + 1}`] = at))
  return { style: vars as CSSProperties, dataStyle: custom.style }
}

/** A small still picture of a gradient, for a swatch or a preview. */
export function swatchBackground(colors: string[], angle = 135): string {
  return `linear-gradient(${angle}deg, ${colors.join(', ')})`
}
