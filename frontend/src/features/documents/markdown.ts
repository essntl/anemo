/**
 * Helpers between a document's file text and what the editors work with.
 *
 * - Front matter (the `---` block at the top) is kept as it is; the rich editor
 *   only edits the body below it.
 * - Images are stored with paths relative to the document's folder (so the file
 *   also works in other Markdown tools); the editor needs URLs it can load.
 */

const FRONT_MATTER = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/
const IMAGE = /(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g
const DOWNLOAD = '/api/files/download?path='

export function splitFrontMatter(text: string): { frontMatter: string; body: string } {
  const match = FRONT_MATTER.exec(text)
  if (!match) return { frontMatter: '', body: text }
  return { frontMatter: match[0], body: text.slice(match[0].length) }
}

export function joinFrontMatter(frontMatter: string, body: string): string {
  if (!frontMatter) return body
  return frontMatter.endsWith('\n') ? frontMatter + body : `${frontMatter}\n${body}`
}

const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** "documents/a" + "../_assets/x.png" -> "documents/_assets/x.png" */
function resolvePath(dir: string, relative: string): string {
  const parts = dir ? dir.split('/') : []
  for (const part of relative.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}

/** Path of `target` as seen from the folder `dir`. */
function relativePath(dir: string, target: string): string {
  const from = dir ? dir.split('/') : []
  const to = target.split('/')
  let common = 0
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++
  return [...Array<string>(from.length - common).fill('..'), ...to.slice(common)].join('/')
}

const isExternal = (src: string) => /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(src)

/** File text -> editor text: relative image paths become URLs the browser can load. */
export function imagesToEditor(body: string, docPath: string): string {
  const dir = dirname(docPath)
  return body.replace(IMAGE, (whole, open: string, src: string, close: string) => {
    if (isExternal(src)) return whole
    let path = src
    try {
      path = decodeURI(src)
    } catch {
      // keep as written
    }
    return `${open}${DOWNLOAD}${encodeURIComponent(resolvePath(dir, path))}${close}`
  })
}

/** Editor text -> file text: our image URLs become paths relative to the document. */
export function imagesToFile(body: string, docPath: string): string {
  const dir = dirname(docPath)
  return body.replace(IMAGE, (whole, open: string, src: string, close: string) => {
    if (!src.startsWith(DOWNLOAD)) return whole
    const path = decodeURIComponent(src.slice(DOWNLOAD.length))
    return `${open}${encodeURI(relativePath(dir, path))}${close}`
  })
}

/**
 * Tidy what the rich editor produces: at most one blank line between blocks
 * (it adds extra ones around tables) and exactly one newline at the end.
 * Code blocks are left exactly as they are.
 */
export function tidyMarkdown(markdown: string): string {
  const parts = markdown.split(/(^```[\s\S]*?^```[ \t]*$|^~~~[\s\S]*?^~~~[ \t]*$)/m)
  const tidied = parts.map((part, i) => (i % 2 === 1 ? part : part.replace(/\n{3,}/g, '\n\n')))
  return `${tidied.join('').replace(/\s+$/, '')}\n`
}

export const assetUrl =(workspacePath: string) => `${DOWNLOAD}${encodeURIComponent(workspacePath)}`

/**
 * True when the body uses Markdown the rich editor cannot keep (raw HTML,
 * footnotes): such documents open in the Markdown source editor instead.
 */
export function needsSourceMode(body: string): boolean {
  const withoutCode = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, '')
  return /<\/?[a-zA-Z][^>\n]*>/.test(withoutCode) || /\[\^[^\]\s]+\]/.test(withoutCode)
}
