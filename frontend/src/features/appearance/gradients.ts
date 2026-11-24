/**
 * The built-in animated backgrounds: three soft colour spots drifting slowly
 * (`.app-gradient` in styles/appearance.css). "Aurora" is made from your accent colour,
 * the others have colours of their own.
 */
import { mix } from '@/lib/color'
import { msg } from '@/lib/i18n'
import type { Background } from './apply'

export type GradientId = Background['gradient']

export const GRADIENTS: { id: GradientId; label: string }[] = [
  { id: 'aurora', label: msg('Aurora') },
  { id: 'dusk', label: msg('Dusk') },
  { id: 'lagoon', label: msg('Lagoon') },
]

/** The three colours of a gradient. */
export function gradientColors(id: GradientId, accent: string): [string, string, string] {
  switch (id) {
    case 'dusk':
      return ['#ff7e5f', '#feb47b', '#7b4397']
    case 'lagoon':
      return ['#00c9a7', '#0081cf', '#845ec2']
    default:
      return [accent, mix(accent, '#00d4ff', 0.55), mix(accent, '#ff4fd8', 0.55)]
  }
}
