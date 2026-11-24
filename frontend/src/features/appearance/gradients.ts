/**
 * The animated backgrounds: soft colour spots drifting slowly (`.app-gradient` in
 * styles/appearance.css). "Aurora" is made from your accent colour, "Dusk" and "Lagoon"
 * have colours of their own, and "Custom" is yours: 2–4 colours, drifting spots or
 * sliding bands (at an angle), and a speed.
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
 * Where the four spots of a drifting custom gradient sit (% of the layer), spread over
 * the four corners so each one shows. With fewer than four colours they repeat.
 */
export const SPOTS = ['24% 28%', '76% 26%', '72% 76%', '26% 74%']

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
  if (background.gradient !== 'custom') {
    colors.forEach((c, i) => (vars[`--g${i + 1}`] = c))
    return { style: vars as CSSProperties }
  }
  // Every spot gets a colour (the colours repeat when there are fewer than four): a
  // spot whose colour is missing would make the browser drop the whole background.
  SPOTS.forEach((at, i) => {
    vars[`--g${i + 1}`] = colors[i % colors.length]
    vars[`--p${i + 1}`] = at
  })
  const custom = background.custom_gradient
  vars['--g-angle'] = `${custom.angle}deg`
  vars['--g-duration'] = `${SPEED_SECONDS[custom.speed]}s`
  vars['--g-stops'] = colors.join(', ')
  return { style: vars as CSSProperties, dataStyle: custom.style }
}

/** A small still picture of a gradient, for a swatch or a preview. */
export function swatchBackground(colors: string[], angle = 135): string {
  return `linear-gradient(${angle}deg, ${colors.join(', ')})`
}
