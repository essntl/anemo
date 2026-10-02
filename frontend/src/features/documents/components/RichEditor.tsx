/**
 * The rich text editor (TipTap) for a document's body, and (`variant="notes"`) for
 * short notes such as a task's. It reads and writes Markdown, so the text stays plain
 * Markdown that any other tool can open.
 *
 * The text is only read when the editor is created: to load other content
 * (another document, a restored revision), give the component a new `key`.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { type Editor, EditorContent, useEditor } from '@tiptap/react'
import { Lingering } from '@/components/ui/Lingering'
import { isAppLink } from '@/lib/appLinks'
import { cn } from '@/lib/cn'
import { uploadAsset } from '../api'
import { editorExtensions } from '../editorExtensions'
import { assetUrl } from '../markdown'
import { EditorToolbar } from './EditorToolbar'
import { LinkPickerDialog } from './LinkPickerDialog'

interface RichEditorProps {
  /** Markdown shown when the editor is created. */
  initial: string
  onChange: (markdown: string) => void
  onError?: (message: string) => void
  /**
   * `document` (default) fills the page and takes images. `notes` is a bordered box
   * without images or tables: it grows with its text up to a limit and then scrolls,
   * or, given a height by `className` (e.g. `flex-1`), fills it and scrolls inside.
   */
  variant?: 'document' | 'notes'
  /** Extra classes for the box of the `notes` variant. */
  className?: string
  /** What the text is, for screen readers. */
  label?: string
  /**
   * Called when a link to another page of the app (a document, a task) is clicked,
   * instead of going there directly: for a form that has to save first.
   */
  onOpenAppLink?: (path: string) => void
}

export function RichEditor({ initial, onChange, onError, variant = 'document', label = 'Document text', onOpenAppLink, className }: RichEditorProps) {
  const notes = variant === 'notes'
  const navigate = useNavigate()
  const fileInput = useRef<HTMLInputElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const [pickingLink, setPickingLink] = useState(false)

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

  /** A click on a link goes there: pages of the app in this tab, other sites in a new one. */
  const openLink = (href: string) => {
    if (!isAppLink(href)) window.open(href, '_blank', 'noopener,noreferrer')
    else if (onOpenAppLink) onOpenAppLink(href)
    else void navigate(href)
  }
  // The editor keeps the handlers it was created with; this lets them reach the current one.
  const openLinkRef = useRef(openLink)
  useEffect(() => {
    openLinkRef.current = openLink
  })

  const editor = useEditor({
    extensions: editorExtensions,
    content: initial,
    contentType: 'markdown',
    onUpdate: ({ editor: e }) => onChange(e.getMarkdown()),
    editorProps: {
      attributes: {
        class: cn('markdown focus:outline-none', notes ? 'min-h-40 flex-1 px-3 py-2.5' : 'min-h-[55vh] px-4 py-5 md:px-8 md:py-7'),
        'aria-label': label,
      },
      handleClick: (_view, _pos, event) => {
        const href = (event.target as HTMLElement).closest('a[href]')?.getAttribute('href')
        if (!href || event.button !== 0) return false
        event.preventDefault()
        openLinkRef.current(href)
        return true
      },
      handlePaste: (_view, event) => {
        const images = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
        if (notes || !images.length) return false
        void insertImages(images)
        return true
      },
      handleDrop: (view, event) => {
        const images = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'))
        if (notes || !images.length) return false
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        void insertImages(images, pos)
        return true
      },
    },
  })
  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  /** Link the selected text to `href`, or insert `title` as the link when nothing is selected. */
  const insertLink = (href: string, title: string) => {
    if (!editor) return
    const chain = editor.chain().focus()
    if (editor.state.selection.empty) chain.insertContent({ type: 'text', text: title, marks: [{ type: 'link', attrs: { href } }] }).run()
    else chain.setLink({ href }).run()
  }

  if (!editor) return null
  const picker = (
    <Lingering value={pickingLink}>
      {() => <LinkPickerDialog onPick={insertLink} onClose={() => setPickingLink(false)} />}
    </Lingering>
  )
  if (notes) {
    return (
      // Columns all the way down, so the text area fills whatever height the box has and
      // a click anywhere in it lands in the editor.
      <div className={cn('flex min-h-0 flex-col overflow-hidden rounded-control border border-border bg-surface focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft', className)}>
        <EditorToolbar editor={editor} onPickLink={() => setPickingLink(true)} />
        <div className="flex max-h-[45dvh] min-h-0 flex-1 flex-col overflow-y-auto md:max-h-none">
          <EditorContent editor={editor} className="flex flex-1 flex-col" />
        </div>
        {picker}
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EditorToolbar editor={editor} onPickLink={() => setPickingLink(true)} onPickImage={() => fileInput.current?.click()} />
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
      {picker}
    </div>
  )
}
