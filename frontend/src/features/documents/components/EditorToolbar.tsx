import type { ReactNode } from 'react'
import { type Editor, useEditorState } from '@tiptap/react'
import {
  Bold,
  Code,
  CodeSquare,
  FileSymlink,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Table,
  Undo2,
} from 'lucide-react'
import { promptDialog } from '@/components/ui/dialogs'
import { cn } from '@/lib/cn'

function ToolButton({ label, active, disabled, onClick, children }: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled}
      // Keep the text selection: the button must not take focus from the editor.
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-text disabled:opacity-30 pointer-coarse:h-10 pointer-coarse:w-10 [&>svg]:h-4 [&>svg]:w-4',
        active && 'bg-accent-soft text-accent',
      )}>
      {children}
    </button>
  )
}

// On a phone the buttons wrap onto rows instead, where dividers would only be in the way.
const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-border max-md:hidden" />

/**
 * Formatting buttons for the rich editor. On a phone they wrap onto as many rows as
 * they need (nothing scrolls sideways).
 * Without `onPickImage` (short notes) the buttons for whole-document things are left
 * out: the largest heading, images, tables and divider lines.
 */
export function EditorToolbar({ editor, onPickLink, onPickImage }: {
  editor: Editor
  /** Opens the picker for a link to a document or task of the app. */
  onPickLink: () => void
  onPickImage?: () => void
}) {
  // Re-render when the selection's formatting changes (the editor itself does not re-render React).
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      link: e.isActive('link'),
      table: e.isActive('table'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  })
  const chain = () => editor.chain().focus()

  const editLink = async () => {
    const current = (editor.getAttributes('link').href as string | undefined) ?? ''
    const url = await promptDialog({ title: 'Link', label: 'Address (empty removes the link)', initial: current, placeholder: 'https://', confirmLabel: 'Apply' })
    if (url === null) return
    if (!url.trim()) chain().extendMarkRange('link').unsetLink().run()
    else chain().extendMarkRange('link').setLink({ href: url.trim() }).run()
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-2 py-1.5 md:flex-nowrap md:overflow-x-auto" role="toolbar" aria-label="Formatting">
      <ToolButton label="Undo" disabled={!state.canUndo} onClick={() => chain().undo().run()}><Undo2 /></ToolButton>
      <ToolButton label="Redo" disabled={!state.canRedo} onClick={() => chain().redo().run()}><Redo2 /></ToolButton>
      <Divider />
      {onPickImage && <ToolButton label="Heading 1" active={state.h1} onClick={() => chain().toggleHeading({ level: 1 }).run()}><Heading1 /></ToolButton>}
      <ToolButton label="Heading 2" active={state.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()}><Heading2 /></ToolButton>
      <ToolButton label="Heading 3" active={state.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()}><Heading3 /></ToolButton>
      <Divider />
      <ToolButton label="Bold" active={state.bold} onClick={() => chain().toggleBold().run()}><Bold /></ToolButton>
      <ToolButton label="Italic" active={state.italic} onClick={() => chain().toggleItalic().run()}><Italic /></ToolButton>
      <ToolButton label="Strikethrough" active={state.strike} onClick={() => chain().toggleStrike().run()}><Strikethrough /></ToolButton>
      <ToolButton label="Inline code" active={state.code} onClick={() => chain().toggleCode().run()}><Code /></ToolButton>
      <ToolButton label="Link" active={state.link} onClick={() => void editLink()}><Link2 /></ToolButton>
      <ToolButton label="Link to a document or task" onClick={onPickLink}><FileSymlink /></ToolButton>
      <Divider />
      <ToolButton label="Bullet list" active={state.bullet} onClick={() => chain().toggleBulletList().run()}><List /></ToolButton>
      <ToolButton label="Numbered list" active={state.ordered} onClick={() => chain().toggleOrderedList().run()}><ListOrdered /></ToolButton>
      <ToolButton label="Checklist" active={state.task} onClick={() => chain().toggleTaskList().run()}><ListChecks /></ToolButton>
      <ToolButton label="Quote" active={state.quote} onClick={() => chain().toggleBlockquote().run()}><Quote /></ToolButton>
      <ToolButton label="Code block" active={state.codeBlock} onClick={() => chain().toggleCodeBlock().run()}><CodeSquare /></ToolButton>
      {onPickImage && (
        <>
          <Divider />
          <ToolButton label="Image" onClick={onPickImage}><ImagePlus /></ToolButton>
          <ToolButton label="Table" active={state.table}
            onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
            <Table />
          </ToolButton>
          <ToolButton label="Divider line" onClick={() => chain().setHorizontalRule().run()}><Minus /></ToolButton>
        </>
      )}
      {state.table && (
        <>
          <Divider />
          {([
            ['Row +', () => chain().addRowAfter().run()],
            ['Row −', () => chain().deleteRow().run()],
            ['Column +', () => chain().addColumnAfter().run()],
            ['Column −', () => chain().deleteColumn().run()],
            ['Delete table', () => chain().deleteTable().run()],
          ] as const).map(([label, run]) => (
            <button key={label} type="button" onMouseDown={(e) => e.preventDefault()} onClick={run}
              className="h-8 shrink-0 rounded-lg px-2 text-[12px] text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10">
              {label}
            </button>
          ))}
        </>
      )}
    </div>
  )
}
