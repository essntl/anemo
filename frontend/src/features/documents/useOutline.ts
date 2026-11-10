import { useEffect, useMemo, useState, type RefObject } from 'react'
import { activeHeading, jumpToHeading } from './jump'
import { splitFrontMatter } from './markdown'
import { outlineOf, wordCount } from './outline'

/**
 * A document's outline for the panel beside it: the headings of its text, the one you
 * are reading under (`active`, while `follow` is on: the rich editor is showing), and
 * `jump` to go to one. `root` is the element that holds the editor.
 */
export function useOutline(root: RefObject<HTMLElement | null>, text: string, follow: boolean) {
  const { outline, words, lineOffset } = useMemo(() => {
    const body = splitFrontMatter(text).body
    // The Markdown editor shows the front matter too: its lines come before the outline's.
    const at = text.indexOf(body)
    return { outline: outlineOf(body), words: wordCount(body), lineOffset: at > 0 ? text.slice(0, at).split('\n').length - 1 : 0 }
  }, [text])

  const [active, setActive] = useState(-1)
  useEffect(() => {
    const el = root.current
    if (!follow || !el) return
    // Scrolling happens inside the editor; it is watched from here, once a frame at most.
    let frame = 0
    const update = () => {
      frame = 0
      setActive(activeHeading(el, outline))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    el.addEventListener('scroll', schedule, true)
    schedule()
    return () => {
      el.removeEventListener('scroll', schedule, true)
      cancelAnimationFrame(frame)
    }
  }, [root, follow, outline])

  const jump = (index: number) => {
    if (root.current && jumpToHeading(root.current, outline, index, lineOffset)) setActive(index)
  }
  return { outline, words, active: follow ? active : -1, jump }
}
