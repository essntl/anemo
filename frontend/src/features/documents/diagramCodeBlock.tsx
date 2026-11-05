/**
 * Code blocks in the document editor. A ```mermaid or ```chart block is shown drawn, with
 * an "Edit" button that shows its source (and a live preview below it while editing).
 * Only the display changes: the block is read and written as the same Markdown as any
 * other code block, so documents keep exactly their text.
 */
import { CodeBlock } from '@tiptap/extension-code-block'
import type { Node as PmNode } from '@tiptap/pm/model'
import type { NodeView } from '@tiptap/pm/view'
import { createRoot, type Root } from 'react-dom/client'
import { Code2, Image as ImageIcon } from 'lucide-react'
import { DiagramBlock } from '@/components/diagrams/DiagramBlock'
import { isDiagramLanguage } from '@/components/diagrams/languages'

class CodeBlockView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private pre: HTMLPreElement
  private preview: HTMLElement | null = null
  private root: Root | null = null
  private editing = false
  private node: PmNode

  constructor(node: PmNode) {
    this.node = node
    this.dom = document.createElement('div')
    this.dom.className = 'code-block-view'
    this.pre = document.createElement('pre')
    this.contentDOM = document.createElement('code')
    this.pre.append(this.contentDOM)
    this.dom.append(this.pre)
    this.render()
  }

  private toggle = () => {
    this.editing = !this.editing
    this.render()
  }

  private render() {
    const lang = (this.node.attrs.language as string | null) ?? null
    this.contentDOM.className = lang ? `language-${lang}` : ''
    if (!isDiagramLanguage(lang)) {
      this.pre.hidden = false
      this.unmount()
      return
    }
    const source = this.node.textContent
    // An empty (new) block shows its source, to be written.
    const editing = this.editing || !source.trim()
    this.pre.hidden = !editing
    if (!this.preview) {
      this.preview = document.createElement('div')
      this.preview.contentEditable = 'false'
      this.preview.className = 'code-block-preview'
      this.dom.append(this.preview)
      this.root = createRoot(this.preview)
    }
    this.preview.hidden = !source.trim()
    this.root?.render(
      <DiagramBlock lang={lang} source={source}
        editAction={
          <button type="button" onClick={this.toggle} aria-pressed={editing}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-hover hover:text-text [&_svg]:h-3 [&_svg]:w-3">
            {editing ? <ImageIcon /> : <Code2 />}
            {editing ? 'Done' : 'Edit'}
          </button>
        } />,
    )
  }

  private unmount() {
    const root = this.root
    this.root = null
    this.preview?.remove()
    this.preview = null
    // Not during a React render (a node view can be destroyed while one is running).
    if (root) queueMicrotask(() => root.unmount())
  }

  update(node: PmNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  /** The drawing handles its own clicks and changes; the editor leaves them alone. */
  stopEvent(event: Event): boolean {
    return Boolean(this.preview && event.target instanceof Node && this.preview.contains(event.target))
  }

  /**
   * Only changes to the text itself are the editor's business: the drawing, and this
   * view showing or hiding its parts (attributes), are not.
   */
  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }): boolean {
    if (mutation.type === 'selection') return false
    if (mutation.type === 'attributes') return true
    return !this.contentDOM.contains(mutation.target)
  }

  destroy() {
    this.unmount()
  }
}

export const DiagramCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ({ node }) => new CodeBlockView(node)
  },
})
