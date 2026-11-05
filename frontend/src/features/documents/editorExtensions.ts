import { Image } from '@tiptap/extension-image'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import { DiagramCodeBlock } from './diagramCodeBlock'

/** The extensions define which Markdown the editor understands (also used in tests). */
export const editorExtensions = [
  // Underline has no Markdown form, so it is left out.
  // Code blocks come from DiagramCodeBlock: the same block, but ```mermaid and ```chart
  // are shown drawn.
  StarterKit.configure({ underline: false, codeBlock: false, link: { openOnClick: false, autolink: true } }),
  DiagramCodeBlock,
  Markdown,
  TableKit.configure({ table: { resizable: false } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Image,
  Placeholder.configure({ placeholder: 'Write something…' }),
]
