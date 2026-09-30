import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { cn } from '@/lib/cn'

interface ComposerProps {
  onSend: (text: string) => void
  onStop?: () => void
  running: boolean
  disabled?: boolean
  placeholder?: string
  /** Controls shown under the text box (model picker, mode switch later). */
  toolbar?: ReactNode
}

export function Composer({ onSend, onStop, running, disabled, placeholder, toolbar }: ComposerProps) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // Grow with the content up to a limit.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  const send = () => {
    const value = text.trim()
    if (!value || running || disabled) return
    onSend(value)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter adds a line. Ignore Enter while an IME is composing.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="rounded-panel border border-border bg-card p-2 shadow-float focus-within:border-accent/50">
      <textarea
        ref={ref}
        rows={1}
        autoFocus
        value={text}
        disabled={disabled}
        placeholder={placeholder ?? 'Message the assistant…'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        className="block max-h-60 w-full resize-none bg-transparent px-3 py-2 text-[14.5px] placeholder:text-subtle focus:outline-none"
      />
      <div className="flex items-center justify-between gap-2 pl-1">
        <div className="flex min-w-0 items-center gap-1">{toolbar}</div>
        {running ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-text text-bg transition-opacity hover:opacity-85"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            aria-label="Send"
            disabled={!text.trim() || disabled}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-full bg-accent text-accent-contrast transition-all',
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
