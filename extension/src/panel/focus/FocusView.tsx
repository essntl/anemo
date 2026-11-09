/**
 * The Focus tab: Anemo's focus timer (the same one as in every Anemo tab), the sites
 * blocked while a focus phase runs, and the music player in your Anemo tab.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, ListTodo, Pause, Play, Plus, RotateCcw, ShieldBan, StepForward, X } from 'lucide-react'
import { unwrap } from '@/shared/api'
import { changeTimer, normalizeSite, sitePatterns, steps, timer, type FocusMirror, type Phase, type Step, type TimerSettings, type TimerState } from '@/shared/focus'
import { releaseFeature } from '@/shared/permissions'
import { Button } from '../ui/Button'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import { Switch } from '../ui/Switch'
import { useAnemoSettings } from '../chat/api'
import { cn } from '../lib/cn'
import { usePreferences } from '../state/preferences'
import { useSession } from '../state/useSession'
import { useStored } from '../state/useStored'
import { MusicCard } from './MusicCard'

/** Now, once a second while `running`. */
function useTick(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running])
  // Stopped or paused, the time left doesn't depend on the clock.
  return now
}

function useOpenTasks() {
  const { api } = useSession()
  return useQuery({ queryKey: ['tasks', 'open'], queryFn: async () => unwrap(await api.GET('/api/tasks', { params: { query: { status: 'open' } } })), staleTime: 60_000 })
}

/** Minutes focused today, from Anemo's focus sessions (refreshed when the timer changes). */
function useToday(version: number) {
  const { api } = useSession()
  return useQuery({
    queryKey: ['focus', 'today', version],
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      const sessions = unwrap(await api.GET('/api/focus/sessions', { params: { query: { start: start.toISOString(), phase: 'focus' } } }))
      return sessions.reduce((sum, s) => sum + s.minutes, 0)
    },
  })
}

function minutes(m: number): string {
  const h = Math.floor(m / 60)
  if (!h) return `${m}m`
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

const PHASES: { phase: Phase; label: string }[] = [
  { phase: 'focus', label: 'Focus' },
  { phase: 'short_break', label: 'Short break' },
  { phase: 'long_break', label: 'Long break' },
]

/** The dial: a ring in the phase's colour, the phase, the time left and the cycle's dots. */
function Dial({ t, settings, now }: { t: TimerState | null; settings: TimerSettings; now: number }) {
  const px = 188
  const stroke = 10
  const r = (px - stroke) / 2
  const c = 2 * Math.PI * r
  const phase = t?.phase ?? 'focus'
  const color = timer.PHASE_COLOR[phase]
  const progress = t ? timer.progress(t, now) : 0
  const left = t ? timer.remaining(t, now) : timer.phaseMs('focus', settings)
  const running = t?.status === 'running'
  const total = Math.max(1, settings.roundsBeforeLongBreak)
  const index = t ? timer.cycleIndex(t, settings) : 0
  return (
    <div className="relative mx-auto" style={{ width: px, height: px }} data-testid="focus-timer">
      <div aria-hidden className="absolute -inset-[8%] rounded-full transition-opacity duration-500" style={{ background: `radial-gradient(closest-side, ${color}, transparent)`, opacity: running ? 0.16 : 0.05 }} />
      <svg width={px} height={px} className="relative -rotate-90" aria-hidden>
        <circle cx={px / 2} cy={px / 2} r={r} fill="none" stroke="var(--ring-track, var(--border))" strokeWidth={stroke} />
        <circle cx={px / 2} cy={px / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - progress)} className="transition-[stroke-dashoffset,stroke] duration-300 ease-linear motion-reduce:transition-none" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color }}>
          {t?.status === 'paused' ? `${timer.PHASE_LABEL[phase]} · paused` : timer.PHASE_LABEL[phase]}
        </span>
        <span className="text-[44px] font-semibold leading-none tracking-tight tabular-nums" aria-label="Time left">
          {timer.formatClock(left)}
        </span>
        <span className="mt-3 flex gap-1.5" role="img" aria-label={`Session ${phase === 'focus' ? index + 1 : index || total} of ${total}`}>
          {Array.from({ length: total }, (_, i) => {
            const done = i < index
            const current = i === index && phase === 'focus'
            return <span key={i} className={cn('h-1.5 rounded-full transition-[width] duration-300', current ? 'w-[18px]' : 'w-1.5')} style={{ background: done || current ? color : 'var(--border-strong)', opacity: done ? 0.6 : 1 }} />
          })}
        </span>
      </div>
    </div>
  )
}

const roundButton = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-40'

function TimerCard({ mirror }: { mirror: FocusMirror | null | undefined }) {
  const { api, connection } = useSession()
  const tasks = useOpenTasks()
  const settings = useAnemoSettings()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const t = mirror?.state ?? null
  const running = t?.status === 'running'
  const now = useTick(running)
  const today = useToday(mirror?.version ?? 0)

  const run = async (name: string, step: Step) => {
    setBusy(name)
    setError(null)
    try {
      const fresh = mirror ?? { state: null, version: 0, settings: timer.DEFAULT_SETTINGS, at: Date.now() }
      await changeTimer(api, fresh, step, { retry: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  if (mirror === undefined) return <Card><CardBody className="text-[13px] text-muted">Loading the timer…</CardBody></Card>
  const timerSettings = mirror?.settings ?? timer.DEFAULT_SETTINGS
  const phase = t?.phase ?? 'focus'
  const idle = !t || t.status === 'idle'
  const color = timer.PHASE_COLOR[phase]
  const goal = settings.data?.focus?.daily_goal_minutes ?? 0
  const done = today.data ?? 0
  const playLabel = running ? 'Pause' : idle ? (phase === 'focus' ? 'Start focus' : 'Start break') : 'Resume'
  const play = () => (running ? run('pause', steps.pause()) : idle && phase === 'focus' ? run('start', steps.startFocus(t?.taskId ?? null)) : run('resume', steps.resume()))
  const taskOptions = [{ value: '', label: 'No task' }, ...(tasks.data ?? []).slice(0, 200).map((x) => ({ value: x.id, label: x.title }))]

  return (
    <Card>
      <CardBody className="flex flex-col gap-4 pt-4">
        <div className="flex items-center gap-2">
          <div role="radiogroup" aria-label="Phase" className="flex flex-1 rounded-control bg-surface-2 p-0.5">
            {PHASES.map((p) => (
              <button
                key={p.phase}
                type="button"
                role="radio"
                aria-checked={phase === p.phase}
                disabled={busy !== null}
                onClick={() => phase !== p.phase && void run('phase', steps.choose(p.phase))}
                className={cn('flex-1 truncate rounded-[8px] px-2 py-1 text-[12px] font-medium', phase === p.phase ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')}
              >
                {p.label}
              </button>
            ))}
          </div>
          <a className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text" href={`${connection.serverUrl}/focus`} target="_blank" rel="noopener noreferrer" title="Open in Anemo" aria-label="Open in Anemo">
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>

        <Dial t={t} settings={timerSettings} now={now} />

        <div className="flex items-center justify-center gap-5">
          <button type="button" className={roundButton} aria-label="Stop" title="Stop (back to the start of the cycle)" disabled={idle || busy !== null} onClick={() => void run('stop', steps.stop())}>
            <RotateCcw className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            aria-label={playLabel}
            title={playLabel}
            disabled={busy !== null}
            onClick={() => void play()}
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-white shadow-soft transition-transform active:scale-95 disabled:opacity-60"
            style={{ background: color }}
          >
            {busy && busy !== 'phase' ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : running ? <Pause className="h-6 w-6" fill="currentColor" /> : <Play className="h-6 w-6 translate-x-0.5" fill="currentColor" />}
          </button>
          <button type="button" className={roundButton} aria-label={phase === 'focus' ? 'Skip to break' : 'Skip break'} title="Skip to the next phase" disabled={busy !== null} onClick={() => void run('skip', steps.skip())}>
            <StepForward className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="focus-task" className="text-[11.5px] font-medium text-muted">
            Working on
          </label>
          <Select id="focus-task" aria-label="Task" value={t?.taskId ?? ''} onValueChange={(v) => void run('task', steps.setTask(v || null))} options={taskOptions} icon={<ListTodo className="h-3.5 w-3.5 shrink-0 text-subtle" />} />
        </div>

        <div className="flex flex-col gap-1.5 border-t border-border pt-3" data-testid="focus-today">
          <div className="flex items-baseline justify-between text-[12.5px]">
            <span className="font-medium">Today</span>
            <span className="text-muted">
              <span className="font-semibold text-text">{minutes(done)}</span>
              {goal > 0 && ` of ${minutes(goal)}`}
            </span>
          </div>
          {goal > 0 && (
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(100, (done / goal) * 100)}%`, background: timer.PHASE_COLOR.focus }} />
            </div>
          )}
        </div>
        {error && <p className="text-[12px] text-error">{error}</p>}
      </CardBody>
    </Card>
  )
}

/** Gives back the host access of sites taken off the list, except where it overlaps what
 *  the extension needs anyway (the Anemo address, YouTube while notes are on). */
async function releaseSites(sites: string[], keep: string[]): Promise<void> {
  const origins = sites.filter((s) => !keep.some((k) => k === s || k.endsWith(`.${s}`))).flatMap(sitePatterns)
  if (origins.length) await chrome.permissions.remove({ origins }).catch(() => false)
}

function BlockingCard() {
  const { prefs, update } = usePreferences()
  const { connection } = useSession()
  const [site, setSite] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [granted, setGranted] = useState<Record<string, boolean>>({})
  const on = prefs.features.focusBlocking
  const keep = [new URL(connection.serverUrl).hostname, ...(prefs.features.youtubeNotes ? ['www.youtube.com'] : [])]

  useEffect(() => {
    void Promise.all(prefs.focusSites.map(async (s) => [s, await chrome.permissions.contains({ origins: sitePatterns(s) })] as const)).then((pairs) => setGranted(Object.fromEntries(pairs)))
  }, [prefs.focusSites])

  const toggle = async (next: boolean) => {
    setError(null)
    if (next) {
      // Blocking, and access to the sites already on the list, in one question.
      const ok = await chrome.permissions.request({ permissions: ['declarativeNetRequestWithHostAccess'], origins: prefs.focusSites.flatMap(sitePatterns) }).catch(() => false)
      if (!ok) {
        setError('Chrome’s permission wasn’t given, so blocking stays off.')
        return
      }
    } else {
      // The rules go first, then the permissions they needed.
      await chrome.declarativeNetRequest?.updateDynamicRules({ removeRuleIds: (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id) }).catch(() => undefined)
      await releaseSites(prefs.focusSites, keep)
      await releaseFeature('focusBlocking')
    }
    await update((p) => ({ ...p, features: { ...p.features, focusBlocking: next } }))
  }

  const add = async () => {
    setError(null)
    const normalized = normalizeSite(site)
    if (!normalized) {
      setError('That isn’t a site address (try “youtube.com”).')
      return
    }
    if (prefs.focusSites.includes(normalized)) {
      setSite('')
      return
    }
    // Straight from the click: redirecting a site to the focus page needs access to it.
    const ok = await chrome.permissions.request({ origins: sitePatterns(normalized) }).catch(() => false)
    if (!ok) {
      setError(`Chrome’s access to ${normalized} wasn’t given, so it can’t be blocked.`)
      return
    }
    setSite('')
    await update((p) => ({ ...p, focusSites: [...p.focusSites, normalized] }))
  }

  const remove = async (s: string) => {
    await update((p) => ({ ...p, focusSites: p.focusSites.filter((x) => x !== s) }))
    await releaseSites([s], keep)
  }

  return (
    <Card>
      <CardHeader
        title="Block distractions"
        description="During focus, these sites show the time left instead. Breaks and pauses are free."
        actions={<Switch label="Block distractions during focus" checked={on} onChange={(v) => void toggle(v)} />}
      />
      <CardBody className="flex flex-col gap-2.5">
        {prefs.focusSites.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Blocked sites">
            {prefs.focusSites.map((s) => (
              <li key={s} className={cn('flex h-7 items-center gap-1.5 rounded-full border pl-2.5 pr-1 text-[12.5px]', granted[s] === false ? 'border-warning/50' : 'border-border bg-surface-2')} title={granted[s] === false ? 'Chrome’s access to this site is missing: remove it and add it again' : undefined}>
                <ShieldBan className={cn('h-3.5 w-3.5 shrink-0', on ? 'text-accent' : 'text-subtle')} />
                <span className="max-w-[12rem] truncate">{s}</span>
                <button type="button" aria-label={`Remove ${s}`} onClick={() => void remove(s)} className="flex h-5 w-5 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-text">
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <Input aria-label="Site to block" placeholder="Add a site, e.g. youtube.com" value={site} onChange={(e) => setSite(e.target.value)} />
          <Button type="submit" size="md" aria-label="Add site" icon={<Plus className="h-4 w-4" />} disabled={!site.trim()}>
            Add
          </Button>
        </form>
        {error && <p className="text-[12px] text-error">{error}</p>}
        {prefs.focusSites.length === 0 && <p className="text-[12px] text-muted">No sites yet. Chrome asks for access to each site you add.</p>}
        {!on && prefs.focusSites.length > 0 && <p className="text-[12px] text-muted">Blocking is off: switch it on to block these during focus.</p>}
      </CardBody>
    </Card>
  )
}

export function FocusView() {
  const mirror = useStored('local', 'focusTimer')
  useEffect(() => {
    // Be current: the worker reads the timer when the panel shows it.
    void chrome.runtime.sendMessage({ type: 'panel.opened' }).catch(() => undefined)
  }, [])
  return (
    <div className="flex flex-col gap-3 p-3">
      <TimerCard mirror={mirror.loaded ? (mirror.value ?? null) : undefined} />
      <BlockingCard />
      <MusicCard />
    </div>
  )
}
