import { Image } from '@tiptap/extension-image'
import { mergeAttributes } from '@tiptap/core'
import { imageHost, loadsWithoutAsking } from '@/lib/remoteImages'
import { t } from '@/lib/i18n'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import { DiagramCodeBlock } from './diagramCodeBlock'

/** Images as before, except that one from another site waits for a click before it loads
 * (a document can be written by an agent; see lib/remoteImages.ts). The document itself is
 * not changed. */
const SafeImage = Image.extend({
  addNodeView() {
    return ({ node, HTMLAttributes }) => {
      const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)
      const image = () => {
        const img = document.createElement('img')
        for (const [key, value] of Object.entries(attrs)) if (value != null) img.setAttribute(key, String(value))
        return img
      }
      const src = node.attrs.src as string | null
      if (loadsWithoutAsking(src)) return { dom: image() }
      const button = document.createElement('button')
      button.type = 'button'
      button.className =
        'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[12px] text-muted hover:text-text'
      button.title = src ?? ''
      const alt = node.attrs.alt as string | null
      const host = imageHost(src ?? '')
      button.textContent = alt ? t('{alt}: show image from {host}', { alt, host }) : t('show image from {host}', { host })
      const dom = document.createElement('span')
      dom.append(button)
      button.addEventListener('click', (event) => {
        event.preventDefault()
        dom.replaceChildren(image())
      })
      return { dom, stopEvent: (event: Event) => event.target === button }
    }
  },
})

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
  SafeImage,
  Placeholder.configure({ placeholder: () => t('Write something…') }),
]
