import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Check, X } from 'lucide-react'
import { useSettings } from '@/features/settings/api'
import { formatDuration } from '@/lib/format'
import { useDoublePress, useShortcut } from '@/hooks/useShortcut'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { dictation, useDictation } from './dictationStore'

/** The bars of the level meter: the middle one moves most. */
const BARS = [0.45, 0.75, 1, 0.75, 0.45]

/** While dictating: what is happening, how long, how loud; finish or cancel. */
function DictationBar() {
  const phase = useDictation((s) => s.phase)
  const startedAt = useDictation((s) => s.startedAt)
  const [now, setNow] = useState(() => Date.now())
  const [level, setLevel] = useState(0)

  useEffect(() => {
    if (phase !== 'recording') return
    const id = window.setInterval(() => {
      setNow(Date.now())
      setLevel(dictation.level())
    }, 80)
    return () => window.clearInterval(id)
  }, [phase])

  if (phase === 'idle') return null
  const recording = phase === 'recording'
  const seconds = recording && startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        // Top centre, under the top bar and the Island: clear of the message box at the bottom.
        'pointer-events-none fixed inset-x-0 top-[calc(max(0.75rem,env(safe-area-inset-top))+3.25rem)] z-[55] flex justify-center px-3',
      )}
    >
      <div className="toast pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-card py-1.5 pl-4 pr-1.5 text-[13px] shadow-float">
        {recording ? (
          <>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-error" aria-hidden />
            <span className="font-medium">{t('Listening')}</span>
            <span className="flex h-5 items-center gap-[3px]" aria-hidden>
              {BARS.map((f, i) => (
                <span key={i} className="w-[3px] rounded-full bg-accent transition-[height] duration-75"
                  style={{ height: `${4 + Math.round(f * level * 16)}px` }} />
              ))}
            </span>
            <span className="tabular-nums text-muted">{formatDuration(seconds, { style: 'timer' })}</span>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void dictation.finish()}
              title={t('Finish (Caps Lock twice)')} aria-label={t('Finish dictating')}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-contrast hover:bg-accent-hover">
              <Check className="h-4 w-4" />
            </button>
          </>
        ) : (
          <>
            <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden />
            <span className="font-medium">{phase === 'starting' ? t('Starting the microphone…') : t('Writing it down…')}</span>
          </>
        )}
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => dictation.cancel()}
          title={t('Cancel (Esc)')} aria-label={t('Cancel dictation')}
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-text">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

/**
 * Dictation for the whole app, rendered once in AppLayout: Caps Lock twice starts and
 * finishes it, Esc cancels, and the bar shows what is happening.
 */
export function DictationHost() {
  const navigate = useNavigate()
  const capsLock = useSettings().data?.dictation?.caps_lock ?? true
  const active = useDictation((s) => s.phase !== 'idle')

  useDoublePress('app.dictate', () => dictation.toggle(), capsLock)
  useShortcut('dictation.cancel', () => dictation.cancel(), { enabled: active, anywhere: true })
  useEffect(() => {
    dictation.setOpenPage((to) => void navigate(to))
    return () => dictation.setOpenPage(null)
  }, [navigate])
  // Leaving the app's layout (signing out) ends a dictation.
  useEffect(() => () => dictation.cancel(), [])

  return <DictationBar />
}
