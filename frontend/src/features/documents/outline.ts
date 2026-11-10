import { slugify } from './passage'

export interface OutlineItem {
  /** 1 to 3: the heading's level. */
  level: number
  /** The heading as it reads: without Markdown's marks, escapes and entities. */
  title: string
  /** What a "#…" link to it ends in. */
  slug: string
  /** The line of the text it is on (the first line is 0). */
  line: number
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** A heading's text as it is shown: links as their words, no marks, escapes or entities. */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // "\*" is a star that was meant; a bare * _ ` ~ is formatting.
    .replace(/\\([\\`*_{}[\]()#+\-.!~>|&])|[*_`~]/g, '$1')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The headings of a Markdown text (levels 1 to 3), in order: a document's outline.
 * Lines inside a code block are not headings.
 */
export function outlineOf(markdown: string): OutlineItem[] {
  const items: OutlineItem[] = []
  let fence: string | null = null
  markdown.split('\n').forEach((line, index) => {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (mark) {
      if (fence === null) fence = mark[1][0]
      else if (mark[1][0] === fence) fence = null
      return
    }
    if (fence !== null) return
    const heading = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!heading) return
    const title = plain(heading[2])
    if (title) items.push({ level: heading[1].length, title, slug: slugify(title), line: index })
  })
  return items
}

/** How many words a text has, counted as the server counts them for the document list. */
export function wordCount(markdown: string): number {
  return markdown.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0
}
