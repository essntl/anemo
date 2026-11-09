import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '../ui/Button'
import { cn } from '../lib/cn'
import { useModels, useProfiles, type Mode } from './api'

export interface ComposerProps {
  draft: string
  onDraft: (text: string) => void
  onSend: () => void
  onStop: () => void
  running: boolean
  sending: boolean
  mode: Mode
  onMode: (mode: Mode) => void
  modelId: string | null
  defaultModelId: string | null
  onModel: (id: string | null) => void
  profileId: string | null
  onProfile: (id: string | null) => void
  /** Shown above the text box (e.g. the page chip). */
  above?: React.ReactNode
}

const selectClass =
  'h-7 max-w-[9.5rem] truncate rounded-md border border-transparent bg-transparent px-1 text-[12px] text-muted hover:bg-surface-hover hover:text-text focus:border-accent focus:outline-none'

export function Composer(p: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const models = useModels()
  const profiles = useProfiles()

  // Grow with the text, up to a third of the panel.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, Math.max(120, window.innerHeight / 3))}px`
  }, [p.draft])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (!p.running && p.draft.trim()) p.onSend()
    }
  }

  const current = p.modelId ?? p.defaultModelId ?? ''
  return (
    <div className="shrink-0 border-t border-border bg-surface px-2.5 pb-2.5 pt-2">
      {p.above}
      <div className="rounded-control border border-border bg-bg focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft">
        <textarea
          ref={ref}
          rows={1}
          value={p.draft}
          onChange={(e) => p.onDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={p.mode === 'agent' ? 'Give the agent a task…' : 'Message Anemo…'}
          aria-label="Message"
          className="block max-h-[40vh] w-full resize-none bg-transparent px-3 py-2 text-[13.5px] leading-relaxed placeholder:text-subtle focus:outline-none"
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <div role="radiogroup" aria-label="Mode" className="flex rounded-md bg-surface-2 p-0.5">
            {(['chat', 'agent'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={p.mode === m}
                onClick={() => p.onMode(m)}
                className={cn('rounded px-2 py-0.5 text-[12px] font-medium capitalize', p.mode === m ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}
              >
                {m}
              </button>
            ))}
          </div>
          <select aria-label="Model" className={selectClass} value={current} onChange={(e) => p.onModel(e.target.value || null)}>
            {!current && <option value="">No model configured</option>}
            {models.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name}
                {m.id === p.defaultModelId ? ' (default)' : ''}
              </option>
            ))}
          </select>
          {p.mode === 'agent' && (profiles.data?.length ?? 0) > 0 && (
            <select aria-label="Agent profile" className={selectClass} value={p.profileId ?? ''} onChange={(e) => p.onProfile(e.target.value || null)}>
              <option value="">Default agent</option>
              {profiles.data?.map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
            </select>
          )}
          <div className="flex-1" />
          {p.running ? (
            <Button size="icon" variant="secondary" aria-label="Stop" title="Stop" onClick={p.onStop} icon={<Square className="h-3.5 w-3.5 fill-current" />} />
          ) : (
            <Button size="icon" variant="primary" aria-label="Send" title="Send (Enter)" disabled={!p.draft.trim()} loading={p.sending} onClick={p.onSend} icon={<ArrowUp className="h-4 w-4" />} />
          )}
        </div>
      </div>
    </div>
  )
}
