import { Image } from '@tiptap/extension-image'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'

/** The extensions define which Markdown the editor understands (also used in tests). */
export const editorExtensions = [
  // Underline has no Markdown form, so it is left out.
  StarterKit.configure({ underline: false, link: { openOnClick: false, autolink: true } }),
  Markdown,
  TableKit.configure({ table: { resizable: false } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Image,
  Placeholder.configure({ placeholder: 'Write something…' }),
]
