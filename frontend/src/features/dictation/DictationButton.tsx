import type { RefObject } from 'react'
import { Mic, Square } from 'lucide-react'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { dictation, useDictation } from './dictationStore'

/** The microphone button of a message box: dictate into it, or finish dictating. */
export function DictationButton({ target, disabled }: { target: RefObject<HTMLTextAreaElement | null>; disabled?: boolean }) {
  const phase = useDictation((s) => s.phase)
  const recording = phase === 'recording'
  const busy = phase === 'starting' || phase === 'working'
  return (
    <button
      type="button"
      // Keep the focus (and the caret) in the text box.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => (recording ? void dictation.finish() : void dictation.start(target.current))}
      disabled={disabled || busy}
      aria-label={recording ? t('Finish dictating') : t('Dictate')}
      title={recording ? t('Finish (Caps Lock twice)') : t('Dictate: speak, and get tidy text (Caps Lock twice)')}
      aria-pressed={recording}
      className={cn(
        'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors pointer-coarse:h-10 pointer-coarse:w-10',
        'disabled:cursor-not-allowed disabled:opacity-40',
        recording ? 'bg-error/10 text-error hover:bg-error/15' : 'text-muted hover:bg-surface-hover hover:text-text',
      )}
    >
      {recording && <span className="absolute inset-0 animate-ping rounded-full bg-error/20 motion-reduce:hidden" aria-hidden />}
      {busy
        ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
        : recording ? <Square className="h-3.5 w-3.5 fill-current" /> : <Mic className="h-4 w-4" />}
    </button>
  )
}
