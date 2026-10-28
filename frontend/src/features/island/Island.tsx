import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useNavigate } from 'react-router'
import { Maximize2, Pause, Play, Plus, SkipBack, SkipForward, StepForward } from 'lucide-react'
import { Equalizer } from '@/components/ui/Equalizer'
import { Ring } from '@/components/ui/Ring'
import { RollingText } from '@/components/ui/RollingText'
import { Slider } from '@/components/ui/Slider'
import { cn } from '@/lib/cn'
import { spring } from '@/lib/motion'
import { formatClock, PHASE_COLOR, PHASE_LABEL } from '@/features/focus/timer'
import { timerActions, useTimer } from '@/features/focus/timerStore'
import { Artwork } from '@/features/music/components/Artwork'
import { formatSeconds } from '@/features/music/format'
import { player, usePlayer } from '@/features/music/player/controller'
import { dismissIslandAlert, useIslandAlerts } from './alerts'
import { AlertBadge, IslandButton } from './IslandParts'
import { useIslandVisible } from './islandStore'

/** How the content of each state appears: a quick blur and scale, or a fade with reduced motion. */
const content = {
  initial: { opacity: 0, scale: 0.92, filter: 'blur(6px)' },
  animate: { opacity: 1, scale: 1, filter: 'blur(0px)', transition: { ...spring.snappy, delay: 0.05 } },
  exit: { opacity: 0, scale: 0.92, filter: 'blur(6px)', transition: { duration: 0.12 } },
}

type Mode = 'hidden' | 'compact' | 'expanded' | 'alert'

/**
 * The Dynamic Island: a dark pill at the top centre of the page area. It is
 *  - hidden while no timer runs and nothing has played,
 *  - compact: the timer (ring, phase, clock) and/or music (cover, bars),
 *  - expanded (click it, or Enter): controls for both; Esc or a click outside closes it,
 *  - an alert for a moment: a finished phase, tracks added, an agent that finished or
 *    needs approval (a click on an approval opens that chat).
 *
 * Rendered once in AppLayout, inside the page column, so it is centred on the content
 * and not the window. While it shows, its width is published as --island-w on the
 * column, so page headers can keep their titles clear of it.
 */
export function Island() {
  const navigate = useNavigate()
  const timer = useTimer()
  const p = usePlayer()
  const alert = useIslandAlerts((s) => s.current)
  const [expanded, setExpanded] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const pill = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)

  // Activity already there when the app opens is just there; only new activity animates in.
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setSettled(true), 800)
    return () => clearTimeout(id)
  }, [])

  const showTimer = timer.active
  const showMusic = p.active
  const hasActivity = showTimer || showMusic
  const mode: Mode = alert ? 'alert' : expanded && hasActivity ? 'expanded' : hasActivity ? 'compact' : 'hidden'
  const phaseColor = PHASE_COLOR[timer.phase]

  // Nothing left to control: the next activity starts compact again.
  if (!hasActivity && expanded) setExpanded(false)
  useEffect(() => useIslandVisible.setState({ visible: mode !== 'hidden' }), [mode])
  // Opening the controls moves focus into them (Esc brings it back).
  useEffect(() => {
    if (mode !== 'expanded') return
    const id = requestAnimationFrame(() => pill.current?.querySelector<HTMLButtonElement>('button')?.focus())
    return () => cancelAnimationFrame(id)
  }, [mode])

  // Close the expanded Island on Esc or a click elsewhere.
  useEffect(() => {
    if (mode !== 'expanded') return
    const onDown = (e: PointerEvent) => {
      if (!pill.current?.contains(e.target as Node)) setExpanded(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setExpanded(false)
      requestAnimationFrame(() => toggleRef.current?.focus())
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [mode])

  // Publish the compact width on the page column (kept while expanded or alerting, so
  // headers don't jump), and 0 when hidden.
  useLayoutEffect(() => {
    const column = wrap.current?.parentElement
    if (!column) return
    column.dataset.island = mode === 'hidden' ? 'off' : 'on'
    if (mode === 'hidden') {
      column.style.setProperty('--island-w', '0px')
      return
    }
    if (mode !== 'compact' || !pill.current) return
    const el = pill.current
    const publish = () => column.style.setProperty('--island-w', `${Math.ceil(el.getBoundingClientRect().width)}px`)
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(el)
    return () => observer.disconnect()
  }, [mode])

  const open = (path: string) => {
    setExpanded(false)
    void navigate(path)
  }
  const cycle = Math.max(1, timer.prefs.roundsBeforeLongBreak)
  const roundOf = timer.phase === 'focus' ? timer.cycleIndex + 1 : timer.cycleIndex || cycle
  const summary = [
    showTimer ? `${PHASE_LABEL[timer.phase]} ${timer.status === 'paused' ? 'paused at' : ''} ${formatClock(timer.remaining)}` : '',
    showMusic && p.track ? `${p.playing ? 'Playing' : 'Paused'}: ${p.track.title}` : '',
  ].filter(Boolean).join(', ')

  return (
    // Compact, the Island keeps clear of a phone's top-bar buttons (px-12); opened or
    // alerting it may use the whole width, as its content is sized to the screen.
    <div ref={wrap} className={cn('pointer-events-none absolute inset-x-0 top-1.5 z-30 flex justify-center px-3 md:top-2',
      mode === 'compact' && 'max-md:px-12')}>
      {/* Alerts are read out; the timer's phase changes are announced by the timer itself. */}
      <div className="sr-only" role="status" aria-live="polite">{alert ? `${alert.title}. ${alert.body ?? ''}` : ''}</div>
      <AnimatePresence>
        {mode !== 'hidden' && (
          <motion.div ref={pill} layout data-testid="island" data-mode={mode}
            initial={settled ? { opacity: 0, scale: 0.6, y: -10 } : false}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.6, y: -10 }}
            transition={spring.island}
            style={{ borderRadius: mode === 'expanded' ? 28 : 22 }}
            className="pointer-events-auto max-w-full select-none overflow-hidden bg-island text-island-fg shadow-float ring-1 ring-island-ring">
            <AnimatePresence mode="popLayout" initial={false}>
              {mode === 'alert' && alert && (
                <motion.button key={`alert-${alert.id}`} {...content} type="button"
                  aria-label={alert.link ? `${alert.title}. Open` : `${alert.title}. Dismiss`}
                  onClick={() => {
                    dismissIslandAlert()
                    if (alert.link) void navigate(alert.link)
                  }}
                  className="flex min-w-[240px] max-w-[min(420px,calc(100vw-1.5rem))] items-center gap-3 py-2 pl-2 pr-5 text-left md:py-2.5">
                  <AlertBadge icon={alert.icon} image={alert.image} tone={alert.tone} />
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-semibold leading-tight">{alert.title}</span>
                    {alert.body && <span className="block truncate text-[12px] leading-tight text-island-muted">{alert.body}</span>}
                  </span>
                </motion.button>
              )}

              {mode === 'compact' && (
                <motion.button key="compact" ref={toggleRef} {...content} type="button" aria-expanded={false}
                  aria-label={`${summary}. Show controls`} onClick={() => setExpanded(true)}
                  className="flex h-9 items-center gap-2.5 px-3 md:h-10">
                  {showTimer && (
                    <span className="flex items-center gap-2">
                      <Ring progress={timer.progress} size={20} stroke={3} color={phaseColor} track="var(--island-track)" />
                      <span className="hidden text-[12px] font-semibold text-island-muted sm:inline">
                        {timer.phase === 'focus' ? 'Focus' : 'Break'}
                      </span>
                      <RollingText value={formatClock(timer.remaining)}
                        className={cn('text-[14px] font-semibold', timer.status === 'paused' && 'text-island-muted')} />
                    </span>
                  )}
                  {showTimer && showMusic && <span className="h-4 w-px bg-island-track" />}
                  {showMusic && (
                    <span className="flex min-w-0 items-center gap-2">
                      <Artwork track={p.track} className="h-6 w-6 rounded-md md:h-7 md:w-7" />
                      {!showTimer && <span className="max-w-[110px] truncate text-[13px] font-medium sm:max-w-[160px]">{p.track!.title}</span>}
                      <Equalizer playing={p.status === 'playing'} className="text-accent" />
                    </span>
                  )}
                </motion.button>
              )}

              {mode === 'expanded' && (
                <motion.div key="expanded" {...content} role="group" aria-label="Focus and music controls"
                  className="flex w-[min(380px,calc(100vw-1.5rem))] flex-col gap-3 p-3.5">
                  {showTimer && (
                    <div className="flex items-center gap-3">
                      <Ring progress={timer.progress} size={46} stroke={4} color={phaseColor} track="var(--island-track)" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[11px] font-semibold uppercase tracking-wider text-island-muted">
                          {PHASE_LABEL[timer.phase]} · {roundOf}/{cycle}
                        </div>
                        <RollingText value={formatClock(timer.remaining)} className="text-[26px] font-semibold leading-none" />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <IslandButton label="Add a minute" onClick={timerActions.addMinute}><Plus /></IslandButton>
                        <IslandButton label="Skip to the next phase" onClick={timerActions.skip}><StepForward /></IslandButton>
                        <IslandButton big label={timer.running ? 'Pause timer' : 'Start timer'} onClick={timerActions.toggle}>
                          {timer.running ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
                        </IslandButton>
                      </div>
                    </div>
                  )}
                  {showTimer && showMusic && <div className="h-px bg-island-control" />}
                  {showMusic && p.track && (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-3">
                        <Artwork track={p.track} className="h-11 w-11 rounded-xl" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[14px] font-semibold">{p.track.title}</div>
                          <div className="truncate text-[12px] text-island-muted">{p.track.artist || '—'}</div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <IslandButton label="Previous track" onClick={player.prev}><SkipBack fill="currentColor" /></IslandButton>
                          <IslandButton big label={p.playing ? 'Pause music' : 'Play music'} onClick={player.toggle}>
                            {p.playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
                          </IslandButton>
                          <IslandButton label="Next track" onClick={player.next}><SkipForward fill="currentColor" /></IslandButton>
                        </div>
                      </div>
                      {!p.track.live && p.duration > 0 && (
                        <div className="flex items-center gap-2 text-[11px] font-medium text-island-muted tabular-nums">
                          <span>{formatSeconds(p.position)}</span>
                          <Slider tone="island" label="Seek" className="flex-1" commit="release" value={p.position} max={p.duration} step={1}
                            onChange={player.seek} valueText={(v) => `${formatSeconds(v)} of ${formatSeconds(p.duration)}`} />
                          <span>{formatSeconds(p.duration)}</span>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex gap-2 text-[12px] font-semibold">
                    {showTimer && (
                      <button type="button" onClick={() => open('/focus')}
                        className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-island-control hover:bg-island-control-hover pointer-coarse:h-10">
                        <Maximize2 className="h-3.5 w-3.5" /> Open Focus
                      </button>
                    )}
                    {showMusic && (
                      <button type="button" onClick={() => open('/music')}
                        className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-island-control hover:bg-island-control-hover pointer-coarse:h-10">
                        <Maximize2 className="h-3.5 w-3.5" /> Open Music
                      </button>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
