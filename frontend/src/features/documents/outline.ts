import { slugify } from './passage'

export interface OutlineItem {
  /** 1 to 3: the heading's level. */
  level: number
  title: string
  /** What a "#…" link to it ends in. */
  slug: string
}

/**
 * The headings of a Markdown text (levels 1 to 3), in order: a document's outline.
 * Lines inside a code block are not headings, and the marks of bold, code and links
 * are left out of the titles.
 */
export function outlineOf(markdown: string): OutlineItem[] {
  const items: OutlineItem[] = []
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (mark) {
      if (fence === null) fence = mark[1][0]
      else if (mark[1][0] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const heading = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!heading) continue
    const title = heading[2]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .trim()
    if (title) items.push({ level: heading[1].length, title, slug: slugify(title) })
  }
  return items
}

/** How many words a text has (as the document list counts them, roughly). */
export function wordCount(markdown: string): number {
  return markdown.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}
