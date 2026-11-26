/*
 * Word count: a panel on documents.
 *
 * It reads the document it is shown next to (`documents.get`, the only permission it needs
 * is `documents:read`), counts its text and shows the numbers. It counts again when the
 * document changes (`object.changed`) or the panel shows another one (`context.changed`),
 * and asks Anemo to make the panel as tall as its content (`anemo.ui.resize`).
 *
 * Everything the document says is shown with `textContent`, never as HTML.
 */

const READING_WPM = 230 // silent reading, words a minute
const SPEAKING_WPM = 140 // reading aloud or presenting

const $ = (id) => document.getElementById(id)

// ---- Counting ---------------------------------------------------------------------------

/**
 * The document's prose, without what isn't read: the front matter (properties between
 * `---` lines at the very top), fenced code blocks (``` or ~~~), HTML comments and tags,
 * and the Markdown marks around the text (heading #, list bullets, quote >, emphasis,
 * link targets). Code and properties aren't words someone reads, so counting them would
 * make the reading time wrong. With `headings: false` the headings are left out too.
 */
function prose(markdown, { headings = true } = {}) {
  let text = markdown.replace(/\r\n?/g, '\n')
  text = text.replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/, '') // front matter
  // Code fences: from an opening ``` or ~~~ line to the closing one (or the end of the text).
  text = text.replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)??(?:\n\1\2[`~]*[ \t]*(?=\n|$)|(?![\s\S]))/gm, '')
  if (!headings) text = text.replace(/^[ \t]{0,3}#{1,6}(?:[ \t].*)?$/gm, '')
  text = text.replace(/<!--[\s\S]*?-->/g, '') // comments
  text = text.replace(/<\/?[a-z][^>]*>/gi, ' ') // HTML tags (their text stays)
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images: their description
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links: their text
  text = text.replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/gm, '') // block marks
  text = text.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '') // horizontal rules
  text = text.replace(/[*_~`]+/g, '') // emphasis and inline code marks
  return text
}

// A word: letters or digits in any script, with ' or - inside ("don't", "e-mail").
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu

function words(text) {
  return text.match(WORD) || []
}

/** All the numbers the panel shows, from the document's Markdown. */
function count(markdown) {
  const text = prose(markdown)
  // Paragraphs: blocks of text between empty lines that have at least one word; a heading
  // is not a paragraph, and a list without empty lines between its items counts as one.
  const paragraphs = prose(markdown, { headings: false })
    .split(/\n[ \t]*\n/)
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter((block) => words(block).length > 0)
  let longest = null
  for (const paragraph of paragraphs) {
    const n = words(paragraph).length
    if (!longest || n > longest.words) longest = { text: paragraph, words: n }
  }
  const total = words(text).length
  const flat = text.replace(/[ \t]*\n[ \t\n]*/g, ' ').trim() // line breaks don't count as characters
  return {
    words: total,
    paragraphs: paragraphs.length,
    // [...s] counts letters, not UTF-16 units, so an emoji or "é" is one character.
    characters: [...flat].length,
    charactersNoSpaces: [...flat.replace(/\s/g, '')].length,
    readingMinutes: total / READING_WPM,
    speakingMinutes: total / SPEAKING_WPM,
    longest,
  }
}

// ---- Showing ----------------------------------------------------------------------------

let numbers = new Intl.NumberFormat('en')

/** "25 sec", "4 min", "1 h 5 min". */
function duration(minutes) {
  if (minutes < 1) return `${Math.max(5, Math.round((minutes * 60) / 5) * 5)} sec` // to 5 seconds
  const rounded = Math.round(minutes)
  if (rounded < 60) return `${rounded} min`
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

/** The first `n` words of a paragraph, with "…" when there are more. */
function firstWords(text, n) {
  const parts = text.split(' ')
  // The cut leaves no comma or full stop right before the "…".
  return parts.length > n ? `${parts.slice(0, n).join(' ').replace(/[\s,;:.!?]+$/, '')}…` : text
}

function showStatus(message) {
  $('status').textContent = message
  $('status').hidden = false
  $('stats').hidden = true
}

function show(c) {
  if (c.words === 0) {
    showStatus('This document has no text yet.')
    return
  }
  $('status').hidden = true
  $('stats').hidden = false
  $('words').textContent = numbers.format(c.words)
  $('paragraphs').textContent = numbers.format(c.paragraphs)
  $('chars').textContent = numbers.format(c.characters)
  $('chars-no-spaces').textContent = numbers.format(c.charactersNoSpaces)
  $('reading').textContent = duration(c.readingMinutes)
  $('speaking').textContent = duration(c.speakingMinutes)
  // Only worth showing when there is more than one paragraph to compare.
  const longest = c.paragraphs > 1 ? c.longest : null
  $('longest').hidden = !longest
  if (longest) {
    $('longest-words').textContent = `${numbers.format(longest.words)} words`
    $('longest-text').textContent = firstWords(longest.text, 12)
  }
}

// ---- Fitting the panel to its content ---------------------------------------------------

let lastHeight = 0

function fit() {
  // The body's own height: the page's (documentElement.scrollHeight) is never less than the
  // frame's, so the panel could grow but never shrink again.
  const height = Math.ceil(document.body.getBoundingClientRect().height)
  if (height === lastHeight) return // asking again for the same height would do nothing
  lastHeight = height
  anemo.ui.resize(height).catch(() => {}) // a page or settings tab keeps its own height
}

// The content's height changes when the numbers do, and when the panel gets narrower or
// wider (the tiles wrap). A ResizeObserver on the body sees both. It starts once the first
// numbers are shown, so the panel doesn't shrink to "Counting…" and grow again.
const sizer = new ResizeObserver(fit)
let sizing = false

function startSizing() {
  if (sizing) return
  sizing = true
  sizer.observe(document.body)
}

// ---- Reading the document ---------------------------------------------------------------

let current = 0 // the newest load; an older one that answers late is ignored

async function load(context) {
  const object = context && context.object
  if (!object || object.type !== 'document') {
    showStatus('Open a document to count its words.')
    startSizing()
    return
  }
  const mine = ++current
  try {
    const doc = await anemo.call('documents.get', { id: object.id })
    if (mine === current) show(count(doc.markdown || ''))
    startSizing()
  } catch (err) {
    if (mine !== current) return
    showStatus(err.code === 'not_found' ? 'This document was deleted.' : `Couldn’t read the document: ${err.message}`)
    startSizing()
  }
}

anemo.ready.then(({ context, locale }) => {
  numbers = new Intl.NumberFormat(locale || 'en') // 1,234 or 1 234, as the user's language writes it
  load(context)
})
// The panel now shows another document.
anemo.on('context.changed', (context) => load(context))
// The document was changed elsewhere (the editor saved, an agent wrote to it): count again.
anemo.on('object.changed', async () => load(await anemo.call('context.get')))
