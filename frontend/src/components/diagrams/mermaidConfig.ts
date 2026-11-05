/**
 * How Mermaid is set up. Diagrams can be written from untrusted content (a web page an
 * agent read), so Mermaid runs in its strict mode: labels are plain text (no HTML), click
 * handlers are off, and a diagram's own `%%{init}%%` settings can't change any of this,
 * the theme, or add CSS (which could load things from other sites).
 */
import type { MermaidConfig } from 'mermaid'
import type { Palette } from './colors'

/** Settings a diagram may not change with `%%{init: …}%%`. */
export const LOCKED_SETTINGS = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'maxEdges',
  'suppressErrorRendering',
  'htmlLabels',
  'theme',
  'themeVariables',
  'themeCSS',
  'darkMode',
  'fontFamily',
  'altFontFamily',
  'flowchart',
  'look',
]

export function mermaidConfig(p: Palette): MermaidConfig {
  const pies = Object.fromEntries(p.series.flatMap((c, i) => [[`pie${i + 1}`, c], [`pie${i + 7}`, c]]))
  // Section colors of mind maps, timelines and journeys: the chart colors, white text.
  const scales = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      [`cScale${i}`, p.series[i % p.series.length]],
      [`cScaleLabel${i}`, '#ffffff'],
    ]).flat(),
  )
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    secure: LOCKED_SETTINGS,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
    maxTextSize: 50_000,
    maxEdges: 500,
    theme: 'base',
    // Flat shapes, like the rest of the app (no hand-drawn look or shadows).
    look: 'classic',
    darkMode: p.dark,
    fontFamily: p.font,
    themeVariables: {
      darkMode: p.dark,
      fontFamily: p.font,
      fontSize: '14px',
      background: p.surface,
      mainBkg: p.surface2,
      primaryColor: p.surface2,
      primaryTextColor: p.text,
      primaryBorderColor: p.accent,
      secondaryColor: p.surfaceHover,
      secondaryTextColor: p.text,
      secondaryBorderColor: p.subtle,
      tertiaryColor: p.surface,
      tertiaryTextColor: p.text,
      tertiaryBorderColor: p.subtle,
      lineColor: p.muted,
      textColor: p.text,
      nodeBorder: p.accent,
      clusterBkg: p.surface,
      clusterBorder: p.subtle,
      titleColor: p.text,
      edgeLabelBackground: p.surface,
      noteBkgColor: p.surfaceHover,
      noteTextColor: p.text,
      noteBorderColor: p.subtle,
      actorBkg: p.surface2,
      actorBorder: p.accent,
      actorTextColor: p.text,
      signalColor: p.text,
      signalTextColor: p.text,
      labelBoxBkgColor: p.surface2,
      labelTextColor: p.text,
      pieStrokeColor: p.surface,
      pieOuterStrokeColor: p.surface,
      pieTitleTextColor: p.text,
      pieSectionTextColor: '#ffffff',
      pieLegendTextColor: p.text,
      ...pies,
      ...scales,
    },
  }
}
