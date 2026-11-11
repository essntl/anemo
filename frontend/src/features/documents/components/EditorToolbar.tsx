import { useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { type Editor, useEditorState } from '@tiptap/react'
import {
  Bold,
  Code,
  CodeSquare,
  FileSymlink,
  Heading,
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
  Plus,
  Quote,
  Redo2,
  Strikethrough,
  Table,
  Undo2,
} from 'lucide-react'
import { promptDialog } from '@/components/ui/dialogs'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'

/** One thing the toolbar does. */
interface Tool {
  label: string
  icon: ReactNode
  active?: boolean
  disabled?: boolean
  run: () => void
}

const BUTTON =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-text disabled:opacity-30 pointer-coarse:h-10 pointer-coarse:w-10 [&>svg]:h-4 [&>svg]:w-4'
const ON = 'bg-accent-soft text-accent'
// Keep the text selection: a button must not take the focus from the editor.
const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault()

function ToolButton({ tool }: { tool: Tool }) {
  return (
    <button type="button" title={tool.label} aria-label={tool.label} aria-pressed={tool.active} disabled={tool.disabled}
      onMouseDown={keepFocus} onClick={tool.run} className={cn(BUTTON, tool.active && ON)}>
      {tool.icon}
    </button>
  )
}

/**
 * Several tools behind one button (a phone has no room for them side by side): it opens
 * a short list of them by name. The editor keeps the focus, so the keyboard stays up.
 */
function ToolMenu({ label, icon, tools }: { label: string; icon: ReactNode; tools: Tool[] }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" title={label} aria-label={label} onMouseDown={keepFocus}
          className={cn(BUTTON, (open || tools.some((t) => t.active)) && ON)}>
          {icon}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} collisionPadding={8}
          onOpenAutoFocus={keepFocus} onCloseAutoFocus={keepFocus}
          className="pop z-50 w-56 rounded-card border border-border bg-card p-1.5 shadow-float">
          <div role="group" aria-label={label}>
            {tools.map((tool) => (
              <button key={tool.label} type="button" aria-pressed={tool.active} disabled={tool.disabled} onMouseDown={keepFocus}
                onClick={() => { setOpen(false); tool.run() }}
                className={cn('flex h-11 w-full items-center gap-3 rounded-control px-2.5 text-left text-[14.5px] hover:bg-surface-hover disabled:opacity-30 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0',
                  tool.active ? 'font-medium text-accent' : '[&>svg]:text-muted')}>
                {tool.icon}{tool.label}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-border" />

/**
 * Formatting buttons for the rich editor. From `md` up every button is in the bar, which
 * wraps onto a second row when the editor is narrow (nothing scrolls sideways). On a phone
 * the bar is one row: the most used buttons, and the rest behind three that open a list
 * (headings, lists and blocks, more).
 * Without `onPickImage` (short notes) the buttons for whole-document things are left
 * out: the largest heading, images, tables and divider lines.
 */
export function EditorToolbar({ editor, onPickLink, onPickImage }: {
  editor: Editor
  /** Opens the picker for a link to a document or task of the app. */
  onPickLink: () => void
  onPickImage?: () => void
}) {
  const desktop = useMediaQuery(DESKTOP)
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

  const undo: Tool = { label: 'Undo', icon: <Undo2 />, disabled: !state.canUndo, run: () => chain().undo().run() }
  const redo: Tool = { label: 'Redo', icon: <Redo2 />, disabled: !state.canRedo, run: () => chain().redo().run() }
  const headings: Tool[] = [
    ...(onPickImage ? [{ label: 'Heading 1', icon: <Heading1 />, active: state.h1, run: () => chain().toggleHeading({ level: 1 }).run() }] : []),
    { label: 'Heading 2', icon: <Heading2 />, active: state.h2, run: () => chain().toggleHeading({ level: 2 }).run() },
    { label: 'Heading 3', icon: <Heading3 />, active: state.h3, run: () => chain().toggleHeading({ level: 3 }).run() },
  ]
  const bold: Tool = { label: 'Bold', icon: <Bold />, active: state.bold, run: () => chain().toggleBold().run() }
  const italic: Tool = { label: 'Italic', icon: <Italic />, active: state.italic, run: () => chain().toggleItalic().run() }
  const strike: Tool = { label: 'Strikethrough', icon: <Strikethrough />, active: state.strike, run: () => chain().toggleStrike().run() }
  const code: Tool = { label: 'Inline code', icon: <Code />, active: state.code, run: () => chain().toggleCode().run() }
  const link: Tool = { label: 'Link', icon: <Link2 />, active: state.link, run: () => void editLink() }
  const appLink: Tool = { label: 'Link to a document, task or file', icon: <FileSymlink />, run: onPickLink }
  const blocks: Tool[] = [
    { label: 'Bullet list', icon: <List />, active: state.bullet, run: () => chain().toggleBulletList().run() },
    { label: 'Numbered list', icon: <ListOrdered />, active: state.ordered, run: () => chain().toggleOrderedList().run() },
    { label: 'Checklist', icon: <ListChecks />, active: state.task, run: () => chain().toggleTaskList().run() },
    { label: 'Quote', icon: <Quote />, active: state.quote, run: () => chain().toggleBlockquote().run() },
    { label: 'Code block', icon: <CodeSquare />, active: state.codeBlock, run: () => chain().toggleCodeBlock().run() },
  ]
  const inserts: Tool[] = onPickImage ? [
    { label: 'Image', icon: <ImagePlus />, run: onPickImage },
    { label: 'Table', icon: <Table />, active: state.table, run: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { label: 'Divider line', icon: <Minus />, run: () => chain().setHorizontalRule().run() },
  ] : []
  const buttons = (tools: Tool[]) => tools.map((tool) => <ToolButton key={tool.label} tool={tool} />)

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-2 py-1.5 max-md:py-1" role="toolbar" aria-label="Formatting">
      {desktop ? (
        <>
          {buttons([undo, redo])}
          <Divider />
          {buttons(headings)}
          <Divider />
          {buttons([bold, italic, strike, code, link, appLink])}
          <Divider />
          {buttons(blocks)}
          {inserts.length > 0 && <Divider />}
          {buttons(inserts)}
        </>
      ) : (
        <>
          {buttons([undo, redo])}
          <ToolMenu label="Headings" icon={<Heading />} tools={headings} />
          {buttons([bold, italic, link])}
          <ToolMenu label="Lists and blocks" icon={<List />} tools={blocks} />
          <ToolMenu label="More" icon={<Plus />} tools={[strike, code, appLink, ...inserts]} />
        </>
      )}
      {state.table && (
        <>
          {desktop && <Divider />}
          {([
            ['Row +', () => chain().addRowAfter().run()],
            ['Row −', () => chain().deleteRow().run()],
            ['Column +', () => chain().addColumnAfter().run()],
            ['Column −', () => chain().deleteColumn().run()],
            ['Delete table', () => chain().deleteTable().run()],
          ] as const).map(([label, run]) => (
            <button key={label} type="button" onMouseDown={keepFocus} onClick={run}
              className="h-8 shrink-0 rounded-lg px-2 text-[12px] text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-10">
              {label}
            </button>
          ))}
        </>
      )}
    </div>
  )
}
