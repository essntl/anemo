/** Every drawing tool by id. The hand tool has no session: the canvas pans for it. */
import { eraseTool } from './erase'
import { freehandTool } from './freehand'
import { selectTool } from './select'
import { shapeTool } from './shape'
import { textTool } from './textTool'
import type { BeginTool, ToolId } from './types'

export const TOOLS: Record<Exclude<ToolId, 'hand'>, BeginTool> = {
  pen: freehandTool('pen'),
  highlighter: freehandTool('highlighter'),
  eraser: eraseTool,
  select: selectTool,
  line: shapeTool('line'),
  arrow: shapeTool('arrow'),
  rect: shapeTool('rect'),
  ellipse: shapeTool('ellipse'),
  text: textTool,
}

export type { BeginTool, ToolHost, ToolId, ToolPoint, ToolSession } from './types'
