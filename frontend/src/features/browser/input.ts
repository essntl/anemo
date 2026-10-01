/**
 * Turns what you do on the picture of the browser (mouse, keyboard) into inputs
 * for the real browser. The picture is scaled to fit the panel, so positions are
 * converted back to the browser's own pixels.
 */
import type { BrowserInput } from './api'

interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** A position on the scaled picture as a position in the browser's page. */
export function pagePoint(
  box: Box,
  clientX: number,
  clientY: number,
  page: { width: number; height: number },
): { x: number; y: number } {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value))
  return {
    x: Math.round(clamp(((clientX - box.left) / box.width) * page.width, page.width)),
    y: Math.round(clamp(((clientY - box.top) / box.height) * page.height, page.height)),
  }
}

/** Keys that are passed on as keys (everything else that prints is passed on as text). */
const SPECIAL_KEYS = new Set([
  'Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]) // prettier-ignore

interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/**
 * What a key press means for the browser:
 *   { kind: 'key' }   a special key, or Ctrl/Cmd+A (select all)
 *   { kind: 'type' }  a character to type
 *   null              not passed on (other shortcuts, modifier keys; paste is handled separately)
 */
export function inputForKey(event: KeyLike): BrowserInput | null {
  if (event.ctrlKey || event.metaKey) {
    return event.key.toLowerCase() === 'a' ? { kind: 'key', key: 'Control+a' } : null
  }
  if (event.altKey) return null
  if (SPECIAL_KEYS.has(event.key)) return { kind: 'key', key: event.key }
  if (event.key.length === 1) return { kind: 'type', text: event.key }
  return null
}

/**
 * Joins inputs that can be sent as one: characters typed quickly become one
 * "type", and several wheel steps become one "scroll". Everything else stays apart.
 */
export function mergeInputs(inputs: BrowserInput[]): BrowserInput[] {
  const merged: BrowserInput[] = []
  for (const input of inputs) {
    const last = merged[merged.length - 1]
    if (last?.kind === 'type' && input.kind === 'type') {
      last.text = (last.text ?? '') + (input.text ?? '')
    } else if (last?.kind === 'scroll' && input.kind === 'scroll') {
      last.dy = (last.dy ?? 0) + (input.dy ?? 0)
      last.x = input.x
      last.y = input.y
    } else {
      merged.push({ ...input })
    }
  }
  return merged
}
