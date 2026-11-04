import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowUp, MessagesSquare, Paperclip, Settings2, Square, SquareSlash, X } from 'lucide-react'
import { Lingering } from '@/components/ui/Lingering'
import { type Skill, useSlashSkills } from '@/features/profiles/api'
import { SkillIcon } from '@/features/skills/icons'
import { matchSkills, slashQuery, typedCommand } from '@/features/skills/slash'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { MAX_ATTACHMENTS, useAttachments } from '../useAttachments'
import { AttachmentChip } from './AttachmentChip'
import { type ChatRef, ChatPickerDialog, MAX_REFERENCES, ReferenceChip } from './ChatReference'

interface ComposerProps {
  /**
   * `referenceIds`: other chats to give the model as context for this message.
   * `skillId`: the skill chosen with / to answer it with.
   */
  onSend: (text: string, attachmentIds: string[], referenceIds: string[], skillId: string | null) => void
  onStop?: () => void
  running: boolean
  disabled?: boolean
  placeholder?: string
  /** Text the box starts with (e.g. a question about a document). */
  initialText?: string
  /** Controls shown under the text box (model picker, mode switch). */
  toolbar?: ReactNode
  /** The chat this composer belongs to: it cannot reference itself. */
  conversationId?: string
  /** Offer skills with / (not when the message answers an agent's question). Default true. */
  skills?: boolean
  /** A skill was chosen (e.g. to switch to Agent mode for one that needs tools). */
  onSkillChange?: (skill: Skill | null) => void
}

/** The box grows with the text up to this height (px), then scrolls. */
const MAX_HEIGHT = 240

export function Composer({
  onSend, onStop, running, disabled, placeholder, initialText, toolbar, conversationId, skills: skillsOn = true, onSkillChange,
}: ComposerProps) {
  const [text, setText] = useState(initialText ?? '')
  const [dragging, setDragging] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const files = useAttachments()
  const [references, setReferences] = useState<ChatRef[]>([])
  const [picking, setPicking] = useState(false)
  // Touch screens: the on-screen keyboard has its own send flow, so Enter adds a line
  // and the box doesn't grab focus (which would pop the keyboard up on every visit).
  const touch = useMediaQuery('(pointer: coarse)')

  // Skills: typing / at the start opens a menu of them; the chosen one is shown as a chip.
  const allSkills = useSlashSkills()
  const slashSkills = skillsOn ? allSkills : []
  const [skill, setSkill] = useState<Skill | null>(null)
  const [active, setActive] = useState(0)
  // The text for which the menu was closed with Escape (it stays closed until that changes).
  const [dismissed, setDismissed] = useState<string | null>(null)
  // Text typed before the menu was opened with the / button: it comes back after the choice.
  const [carried, setCarried] = useState('')
  const query = skill ? null : slashQuery(text)
  const matches = query === null ? [] : matchSkills(slashSkills, query)
  const menuOpen = query !== null && dismissed !== text && slashSkills.length > 0
  const menuId = useId()
  const chosen = skillsOn ? skill : null

  const chooseSkill = (next: Skill | null, rest = carried) => {
    setSkill(next)
    setText(rest)
    setCarried('')
    setActive(0)
    onSkillChange?.(next)
    textRef.current?.focus()
  }

  const onChange = (value: string) => {
    // "/study " typed or pasted in full: the same as choosing it from the menu.
    const typed = !skill && skillsOn ? typedCommand(slashSkills, value) : null
    if (typed) chooseSkill(typed.skill, typed.rest || carried)
    else if (carried && slashQuery(value) === null) {
      // The slash was deleted or the menu left otherwise: the earlier text comes back.
      setText(value ? `${value} ${carried}` : carried)
      setCarried('')
    } else {
      setText(value)
      setActive(0)
    }
  }

  // Grow with the content up to a limit; only then can it scroll. (On phones the measured
  // height can come out a fraction short, which left an empty box scrollable by a pixel.)
  useEffect(() => {
    const el = textRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [text])

  const canSend = Boolean(text.trim()) && !running && !disabled && !files.uploading

  const send = () => {
    if (!canSend) return
    onSend(text.trim(), files.readyIds, references.map((r) => r.id), chosen?.id ?? null)
    setText('')
    files.clear()
    setReferences([])
    if (skill) {
      setSkill(null)
      onSkillChange?.(null)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && !e.nativeEvent.isComposing) {
      const count = matches.length
      if (e.key === 'ArrowDown' && count) {
        e.preventDefault()
        setActive((active + 1) % count)
        return
      }
      if (e.key === 'ArrowUp' && count) {
        e.preventDefault()
        setActive((active - 1 + count) % count)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && count) {
        e.preventDefault()
        chooseSkill(matches[Math.min(active, count - 1)])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (carried) {
          setText(carried)
          setCarried('')
        } else setDismissed(text)
        return
      }
    }
    // Backspace in an empty box takes the chosen skill off again.
    if (e.key === 'Backspace' && skill && !text && e.currentTarget.selectionStart === 0) {
      e.preventDefault()
      chooseSkill(null)
      return
    }
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
        'relative rounded-panel border bg-card p-2 shadow-float transition-colors focus-within:border-accent/50',
        dragging ? 'border-accent bg-accent-soft' : 'border-border',
      )}
    >
      {references.length > 0 && (
        <div className="flex flex-wrap gap-2 px-2 pb-1 pt-2">
          {references.map((r) => (
            <ReferenceChip key={r.id} chat={r} onRemove={() => setReferences(references.filter((x) => x.id !== r.id))} />
          ))}
        </div>
      )}
      {files.items.length > 0 && (
        <div className="flex flex-wrap gap-2 px-2 pb-1 pt-2">
          {files.items.map((f) => (
            <AttachmentChip
              key={f.key}
              name={f.file.name}
              size={f.file.size}
              kind={f.uploaded?.kind}
              imageUrl={f.previewUrl}
              status={f.status}
              error={f.error}
              onRemove={() => files.remove(f.key)}
            />
          ))}
        </div>
      )}
      {menuOpen && (
        <div className="pop absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-card border border-border bg-card shadow-float">
          <div className="flex items-center justify-between px-3 pb-1 pt-2.5 text-[11.5px] font-medium uppercase tracking-wide text-subtle">
            Skills
            <span className="hidden normal-case tracking-normal md:inline">↑↓ to choose · Enter to use · Esc to close</span>
          </div>
          <div id={menuId} role="listbox" aria-label="Skills" className="max-h-72 overflow-y-auto p-1.5 pt-0">
            {matches.map((s, i) => (
              <div key={s.id} id={`${menuId}-${i}`} role="option" aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()} // keep the focus in the text box
                onMouseEnter={() => setActive(i)}
                onClick={() => chooseSkill(s)}
                className={cn('flex cursor-pointer items-center gap-3 rounded-control px-2.5 py-2 pointer-coarse:py-2.5',
                  i === active ? 'bg-surface-hover' : '')}>
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  <SkillIcon name={s.icon} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13.5px] font-medium">{s.name}</span>
                    <span className="font-mono text-[12px] text-subtle">/{s.slug}</span>
                  </div>
                  <div className="truncate text-[12.5px] text-muted">{s.hint || s.description}</div>
                </div>
              </div>
            ))}
            {matches.length === 0 && <p className="px-2.5 py-2 text-[13px] text-muted">No skill matches “/{query}”.</p>}
          </div>
          <Link to="/settings/skills" onMouseDown={(e) => e.preventDefault()}
            className="flex items-center gap-2 border-t border-border px-4 py-2 text-[12.5px] text-muted hover:bg-surface-hover hover:text-text">
            <Settings2 className="h-3.5 w-3.5" /> Manage skills
          </Link>
        </div>
      )}
      <div className="flex items-start">
        {chosen && (
          <button type="button" onClick={() => chooseSkill(null, text)} title="Remove the skill (or Backspace in an empty box)"
            aria-label={`Skill: ${chosen.name}. Remove it`}
            className="group/skill ml-1.5 mt-1.5 flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-accent-soft pl-2 pr-2.5 text-[13px] font-medium text-accent hover:bg-accent/15">
            <span className="relative flex h-4 w-4 items-center justify-center">
              <SkillIcon name={chosen.icon} className="transition-opacity group-hover/skill:opacity-0" />
              <X className="absolute h-3.5 w-3.5 opacity-0 transition-opacity group-hover/skill:opacity-100" aria-hidden />
            </span>
            {chosen.name}
          </button>
        )}
        <textarea
          ref={textRef}
          rows={1}
          autoFocus={!touch}
          value={text}
          disabled={disabled}
          placeholder={
            dragging ? 'Drop files to attach'
              : chosen ? (chosen.hint || chosen.description)
                : (placeholder ?? (slashSkills.length ? 'Message the assistant… (/ for skills)' : 'Message the assistant…'))
          }
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          role={menuOpen ? 'combobox' : undefined}
          aria-expanded={menuOpen ? true : undefined}
          aria-controls={menuOpen ? menuId : undefined}
          aria-activedescendant={menuOpen && matches.length ? `${menuId}-${Math.min(active, matches.length - 1)}` : undefined}
          className="block max-h-60 min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-[14.5px] placeholder:text-subtle focus:outline-none"
        />
      </div>
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
          <button
            type="button"
            aria-label="Reference a chat"
            title="Reference another chat as context"
            disabled={disabled || references.length >= MAX_REFERENCES}
            onClick={() => setPicking(true)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-text disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-10"
          >
            <MessagesSquare className="h-4 w-4" />
          </button>
          {slashSkills.length > 0 && (
            <button
              type="button"
              aria-label="Use a skill"
              title="Use a skill (type / at the start)"
              disabled={disabled}
              onClick={() => {
                if (skill) chooseSkill(null, text)
                else if (!menuOpen) {
                  setCarried(text)
                  setText('/')
                  setDismissed(null)
                  textRef.current?.focus()
                }
              }}
              className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-surface-hover hover:text-text disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-10',
                skill ? 'text-accent' : 'text-muted')}
            >
              <SquareSlash className="h-4 w-4" />
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            multiple
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
      <Lingering value={picking}>
        {() => (
          <ChatPickerDialog
            exclude={[...(conversationId ? [conversationId] : []), ...references.map((r) => r.id)]}
            onPick={(chat) => setReferences([...references, chat])}
            onClose={() => setPicking(false)}
          />
        )}
      </Lingering>
    </div>
  )
}
