/** The text tool: a tap on a text box edits it, a tap anywhere else starts a new one there. */
import { isText, type SketchItem, type TextBox } from '../../model'
import { hitItem } from '../geometry'
import type { BeginTool } from './types'

/** The text box at (x, y), topmost first. */
export function textAt(items: readonly SketchItem[], x: number, y: number, tolerance: number): TextBox | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (isText(item) && hitItem(item, x, y, tolerance)) return item
  }
  return null
}

export const textTool: BeginTool = (host) => ({
  move: () => {},
  end(p) {
    const box = textAt(host.data.items, p.x, p.y, 4 / host.zoom)
    host.editText(box ?? { x: p.x, y: p.y })
  },
  cancel: () => {},
})
