/**
 * A second safety net after Mermaid's strict mode, before a drawing goes into the page:
 * only SVG survives (no scripts, event handlers, HTML or embedded pages), links lose
 * their target unless it points inside the drawing (`#…`), and CSS can't load anything
 * (`url(…)` and `@import` are removed). Images are dropped, so nothing is fetched from
 * another site.
 */
import DOMPurify from 'dompurify'

const EXTERNAL_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi
const IMPORT = /@import[^;]*;?/gi

export function cleanCss(css: string): string {
  return css.replace(IMPORT, '').replace(EXTERNAL_URL, 'none')
}

export function sanitizeSvg(svg: string): string {
  const purify = DOMPurify(window)
  purify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) node.textContent = cleanCss(node.textContent)
  })
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return
    for (const name of ['href', 'xlink:href']) {
      const value = node.getAttribute(name)
      if (value !== null && !value.trim().startsWith('#')) node.removeAttribute(name)
    }
    const style = node.getAttribute('style')
    if (style) node.setAttribute('style', cleanCss(style))
  })
  return purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'image', 'script', 'iframe', 'object', 'embed'],
    ADD_TAGS: ['style'],
  })
}
