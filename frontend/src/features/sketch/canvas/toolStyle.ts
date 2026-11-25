/**
 * The sizes each tool offers and the choices the toolbar keeps: a colour for the pen,
 * the shapes and text, another for the highlighter, and a size per kind of tool.
 */
import { msg } from '@/lib/i18n'
import { INK } from '../model'
import type { EraseMode } from './eraser'
import { HIGHLIGHTER_COLOR } from './palette'
import type { ToolId } from './tools/types'

/** Tools that share one size choice. */
export type SizeGroup = 'pen' | 'highlighter' | 'shape' | 'text' | 'eraser'

export interface SizePreset {
  value: number
  label: string
}

/**
 * Sizes in sheet units (pen, highlighter and shapes: line width; text: font size),
 * except the eraser's, which is a diameter on screen.
 */
export const SIZES: Record<SizeGroup, SizePreset[]> = {
  pen: [
    { value: 1.5, label: msg('Fine') },
    { value: 3, label: msg('Medium') },
    { value: 6, label: msg('Thick') },
    { value: 12, label: msg('Marker') },
  ],
  highlighter: [
    { value: 10, label: msg('Thin') },
    { value: 18, label: msg('Medium') },
    { value: 30, label: msg('Wide') },
  ],
  shape: [
    { value: 1.5, label: msg('Fine') },
    { value: 3, label: msg('Medium') },
    { value: 6, label: msg('Thick') },
  ],
  text: [
    { value: 16, label: msg('Small') },
    { value: 24, label: msg('Medium') },
    { value: 36, label: msg('Large') },
    { value: 56, label: msg('Huge') },
  ],
  eraser: [
    { value: 12, label: msg('Small') },
    { value: 28, label: msg('Medium') },
    { value: 60, label: msg('Large') },
  ],
}

export function sizeGroup(tool: ToolId): SizeGroup | null {
  if (tool === 'pen' || tool === 'highlighter' || tool === 'text' || tool === 'eraser') return tool
  if (tool === 'line' || tool === 'arrow' || tool === 'rect' || tool === 'ellipse') return 'shape'
  return null
}

/** Whether the tool draws in a colour (and which of the two colours it uses). */
export const colorSlot = (tool: ToolId): 'ink' | 'highlighter' | null =>
  tool === 'highlighter' ? 'highlighter' : sizeGroup(tool) && tool !== 'eraser' ? 'ink' : null

export interface ToolStyle {
  colors: Record<'ink' | 'highlighter', string>
  sizes: Record<SizeGroup, number>
  eraseMode: EraseMode
}

export const DEFAULT_STYLE: ToolStyle = {
  colors: { ink: INK, highlighter: HIGHLIGHTER_COLOR },
  sizes: { pen: 3, highlighter: 18, shape: 3, text: 24, eraser: 28 },
  eraseMode: 'whole',
}

/** The colour and size the tool draws with now. */
export function styleFor(style: ToolStyle, tool: ToolId): { color: string; width: number } {
  const slot = colorSlot(tool)
  const group = sizeGroup(tool)
  return { color: slot ? style.colors[slot] : INK, width: group ? style.sizes[group] : 1 }
}
