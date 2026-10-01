import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUp, Paperclip, Square } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { MAX_ATTACHMENTS, useAttachments } from '../useAttachments'
import { AttachmentChip } from './AttachmentChip'

interface ComposerProps {
  onSend: (text: string, attachmentIds: string[]) => void
  onStop?: () => void
  running: boolean
  disabled?: boolean
  placeholder?: string
  /** Text the box starts with (e.g. a question about a document). */
  initialText?: string
  /** Controls shown under the text box (model picker, mode switch). */
  toolbar?: ReactNode
}

const ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.csv,.json,.yaml,.yml,.toml,.py,.js,.ts,.tsx,.jsx,.go,.rs,.java,.c,.cpp,.h,.cs,.rb,.php,.sh,.sql,.html,.css,.xml,.log'

export function Composer({ onSend, onStop, running, disabled, placeholder, initialText, toolbar }: ComposerProps) {
  const [text, setText] = useState(initialText ?? '')
  const [dragging, setDragging] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const files = useAttachments()
  // Touch screens: the on-screen keyboard has its own send flow, so Enter adds a line
  // and the box doesn't grab focus (which would pop the keyboard up on every visit).
  const touch = useMediaQuery('(pointer: coarse)')

  // Grow with the content up to a limit.
  useEffect(() => {
    const el = textRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  const canSend = Boolean(text.trim()) && !running && !disabled && !files.uploading

  const send = () => {
    if (!canSend) return
    onSend(text.trim(), files.readyIds)
    setText('')
    files.clear()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter adds a line (not on touch screens). Ignore Enter while an IME is composing.
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(e.clipboardData.files)
    if (pasted.length) {
      e.preventDefault()
      files.add(pasted)
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length) files.add(e.dataTransfer.files)
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        'rounded-panel border bg-card p-2 shadow-float transition-colors focus-within:border-accent/50',
        dragging ? 'border-accent bg-accent-soft' : 'border-border',
      )}
    >
      {files.items.length > 0 && (
        <div className="flex flex-wrap gap-2 px-2 pb-1 pt-2">
          {files.items.map((f) => (
            <AttachmentChip
              key={f.key}
              name={f.file.name}
              size={f.file.size}
              imageUrl={f.previewUrl}
              status={f.status}
              error={f.error}
              onRemove={() => files.remove(f.key)}
            />
          ))}
        </div>
      )}
      <textarea
        ref={textRef}
        rows={1}
        autoFocus={!touch}
        value={text}
        disabled={disabled}
        placeholder={dragging ? 'Drop files to attach' : (placeholder ?? 'Message the assistant…')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="block max-h-60 w-full resize-none bg-transparent px-3 py-2 text-[14.5px] placeholder:text-subtle focus:outline-none"
      />
      <div className="flex items-center justify-between gap-1 pl-1 md:gap-2">
        <div className="flex min-w-0 items-center gap-0.5 md:gap-1">
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files (or drop / paste them)"
            disabled={disabled || files.items.length >= MAX_ATTACHMENTS}
            onClick={() => fileRef.current?.click()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-text disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-10"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) files.add(e.target.files)
              e.target.value = ''
            }}
          />
          {toolbar}
        </div>
        {running ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-text text-bg transition-opacity hover:opacity-85 pointer-coarse:h-10 pointer-coarse:w-10"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            aria-label="Send"
            disabled={!canSend}
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-contrast transition-all pointer-coarse:h-10 pointer-coarse:w-10',
              'hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
