import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activeHeading, headingFor, jumpToHeading } from './jump'
import { outlineOf } from './outline'

const TEXT = '# Archive &amp; Rebuild\n\n## Marriage\n\ntext\n\n# Nicole\n\n## Marriage\n\n### Things she likes\n'

/** A page as the rich editor draws that text, each heading at its own height. */
function page(tops: number[] = [0, 100, 200, 300, 400]): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `<div class="overflow-y-auto"><div class="ProseMirror">
    <h1>Archive &amp; Rebuild</h1><h2>Marriage</h2><p>text</p><h1>Nicole</h1><h2>Marriage</h2><h3>Things she likes</h3>
  </div></div>`
  document.body.replaceChildren(root)
  root.querySelectorAll('h1, h2, h3').forEach((h, i) => {
    h.getBoundingClientRect = () => ({ top: tops[i] }) as DOMRect
    ;(h as HTMLElement).scrollIntoView = vi.fn()
  })
  root.querySelector<HTMLElement>('.overflow-y-auto')!.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
  return root
}

const outline = outlineOf(TEXT)

beforeEach(() => document.body.replaceChildren())

describe('from the outline to the heading', () => {
  it('finds a heading whose text has an entity or was escaped', () => {
    expect(outline[0].title).toBe('Archive & Rebuild')
    expect(headingFor(page(), outline, 0)?.tagName).toBe('H1')
  })

  it('tells two headings with the same words apart by their order', () => {
    const root = page()
    const all = [...root.querySelectorAll('h2')]
    expect(headingFor(root, outline, 1)).toBe(all[0])
    expect(headingFor(root, outline, 3)).toBe(all[1])
  })

  it('scrolls the heading itself into view, also when clicked twice', () => {
    const root = page()
    const target = root.querySelectorAll('h2')[1] as HTMLElement
    expect(jumpToHeading(root, outline, 3)).toBe(true)
    expect(jumpToHeading(root, outline, 3)).toBe(true)
    expect(target.scrollIntoView).toHaveBeenCalledTimes(2)
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
  })

  it('says so when there is nothing to go to', () => {
    expect(jumpToHeading(document.createElement('div'), outline, 2)).toBe(false)
    expect(headingFor(page(), outline, 99)).toBeNull()
  })
})

describe('the heading you are reading under', () => {
  it('is the last one at or above the top of the view', () => {
    // Scrolled so that "Nicole" has just passed the top and the second "Marriage" has not.
    expect(activeHeading(page([-300, -200, 10, 120, 240]), outline)).toBe(2)
    expect(activeHeading(page([-500, -400, -300, -200, 20]), outline)).toBe(4)
  })

  it('is none before the first heading', () => {
    expect(activeHeading(page([80, 180, 280, 380, 480]), outline)).toBe(-1)
    expect(activeHeading(document.createElement('div'), outline)).toBe(-1)
  })
})
