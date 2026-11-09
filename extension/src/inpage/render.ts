/**
 * Markdown for the in-page box: marked → DOMPurify. Code is highlighted (highlight.js),
 * math is KaTeX rendered as MathML (Chrome draws it itself, so no font files are exposed
 * to the page). Images are dropped (nothing loads into the page) and links open in a new
 * tab; only http(s) links are kept.
 */
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import katex from 'katex'
import { Marked, type TokenizerAndRendererExtension } from 'marked'

function math(expr: string, display: boolean): string {
  return katex.renderToString(expr, { output: 'mathml', displayMode: display, throwOnError: false, trust: false, strict: 'ignore' })
}

const blockMath: TokenizerAndRendererExtension = {
  name: 'blockMath',
  level: 'block',
  start: (src) => src.indexOf('$$'),
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$/.exec(src)
    return m ? { type: 'blockMath', raw: m[0], text: m[1].trim() } : undefined
  },
  renderer: (token) => `<div class="math">${math(String(token.text), true)}</div>`,
}

const inlineMath: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start: (src) => src.indexOf('$'),
  tokenizer(src) {
    const m = /^\$([^$\n]+?)\$/.exec(src)
    return m ? { type: 'inlineMath', raw: m[0], text: m[1] } : undefined
  },
  renderer: (token) => math(String(token.text), false),
}

const marked = new Marked({ gfm: true, breaks: false })
marked.use({ extensions: [blockMath, inlineMath] })
marked.use({
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined
      const html = language ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value
      return `<div class="code"><div class="code-head"><span>${language ?? 'code'}</span><button type="button" class="copy-code">Copy</button></div><pre><code class="hljs">${html}</code></pre></div>`
    },
  },
})

let hooked = false
function hook(): void {
  if (hooked) return
  hooked = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? ''
      if (!/^https?:\/\//i.test(href)) node.removeAttribute('href')
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  })
}

/** Safe HTML for Markdown from the model. */
export function renderMarkdown(markdown: string): string {
  hook()
  const html = marked.parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: ['img', 'style', 'form', 'input', 'textarea', 'select', 'iframe', 'video', 'audio', 'source', 'picture', 'svg'],
    FORBID_ATTR: ['style', 'srcset'],
    ADD_ATTR: ['target'],
  })
}
