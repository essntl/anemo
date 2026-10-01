/**
 * The rich text editor (TipTap) for a document's body. It reads and writes
 * Markdown, so the file stays plain Markdown that any other tool can open.
 *
 * The text is only read when the editor is created: to load other content
 * (another document, a restored revision), give the component a new `key`.
 */
import { useEffect, useRef } from 'react'
import { type Editor, EditorContent, useEditor } from '@tiptap/react'
import { uploadAsset } from '../api'
import { editorExtensions } from '../editorExtensions'
import { assetUrl } from '../markdown'
import { EditorToolbar } from './EditorToolbar'

interface RichEditorProps {
  /** Markdown shown when the editor is created. */
  initial: string
  onChange: (markdown: string) => void
  onError?: (message: string) => void
}

export function RichEditor({ initial, onChange, onError }: RichEditorProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const editorRef = useRef<Editor | null>(null)

  /** Upload images and insert them at the cursor (or at `pos` for a drop). */
  const insertImages = async (files: File[], pos?: number) => {
    for (const file of files.filter((f) => f.type.startsWith('image/'))) {
      try {
        const path = await uploadAsset(file)
        const image = { type: 'image', attrs: { src: assetUrl(path), alt: file.name.replace(/\.[^.]+$/, '') } }
        const chain = editorRef.current?.chain().focus()
        if (pos === undefined) chain?.insertContent(image).run()
        else chain?.insertContentAt(pos, image).run()
      } catch (err) {
        onError?.(err instanceof Error ? err.message : 'The image could not be added')
      }
    }
  }

  const editor = useEditor({
    extensions: editorExtensions,
    content: initial,
    contentType: 'markdown',
    onUpdate: ({ editor: e }) => onChange(e.getMarkdown()),
    editorProps: {
      attributes: { class: 'markdown min-h-[55vh] px-4 py-5 focus:outline-none md:px-8 md:py-7', 'aria-label': 'Document text' },
      handlePaste: (_view, event) => {
        const images = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
        if (!images.length) return false
        void insertImages(images)
        return true
      },
      handleDrop: (view, event) => {
        const images = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'))
        if (!images.length) return false
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        void insertImages(images, pos)
        return true
      },
    },
  })
  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  if (!editor) return null
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EditorToolbar editor={editor} onPickImage={() => fileInput.current?.click()} />
      <input ref={fileInput} type="file" accept="image/*" multiple hidden
        onChange={(e) => {
          void insertImages(Array.from(e.target.files ?? []))
          e.target.value = ''
        }} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  )
}
