import { Image } from '@tiptap/extension-image'
import { mergeAttributes } from '@tiptap/core'
import { documentLink, sketchIdOfPreview } from '@/lib/appLinks'
import { imageHost, loadsWithoutAsking } from '@/lib/remoteImages'
import { t } from '@/lib/i18n'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import { DiagramCodeBlock } from './diagramCodeBlock'

/**
 * An embedded sketch in the editor: its image with a small link that opens the sketch (a
 * click on a link goes there, see RichEditor). Without an image yet, its name instead.
 */
function sketchEmbed(id: string, img: HTMLImageElement, alt: string | null): HTMLElement {
  const dom = document.createElement('span')
  dom.className = 'sketch-embed relative inline-block max-w-full'
  img.classList.add('rounded-md', 'border', 'border-border', 'bg-white')
  const open = document.createElement('a')
  open.href = documentLink(id)
  open.textContent = t('Open sketch')
  open.className = 'absolute right-2 top-2 rounded-md border border-border bg-surface px-2 py-0.5 text-[12px] font-medium text-text no-underline shadow-soft hover:bg-surface-hover'
  img.addEventListener('error', () => {
    const missing = document.createElement('span')
    missing.className = 'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 py-1 pl-2 pr-24 text-[12px] text-muted'
    missing.textContent = alt || t('Embedded sketch')
    img.replaceWith(missing)
  })
  dom.append(img, open)
  return dom
}

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
      const sketch = sketchIdOfPreview(src)
      if (sketch) return { dom: sketchEmbed(sketch, image(), node.attrs.alt as string | null) }
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
