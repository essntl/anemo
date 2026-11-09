/**
 * The Focus tab: Anemo's focus timer (the same one as in every Anemo tab), the sites
 * blocked while a focus phase runs, and the music player in your Anemo tab.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Pause, Play, Plus, ShieldBan, SkipForward, Square, Timer, X } from 'lucide-react'
import { unwrap } from '@/shared/api'
import { changeTimer, normalizeSite, sitePatterns, steps, timer, type FocusMirror, type Step } from '@/shared/focus'
import { releaseFeature } from '@/shared/permissions'
import { Button } from '../ui/Button'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { Input } from '../ui/Input'
import { Switch } from '../ui/Switch'
import { cn } from '../lib/cn'
import { usePreferences } from '../state/preferences'
import { useSession } from '../state/useSession'
import { useStored } from '../state/useStored'
import { MusicCard } from './MusicCard'

/** Now, once a second while `running`. */
function useNow(running: boolean): number {
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

function TimerCard({ mirror }: { mirror: FocusMirror | null | undefined }) {
  const { api, connection } = useSession()
  const tasks = useOpenTasks()
  const [taskId, setTaskId] = useState<string>('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const t = mirror?.state ?? null
  const running = t?.status === 'running'
  const now = useNow(running)

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
  const task = t?.taskId ? tasks.data?.find((x) => x.id === t.taskId) : undefined
  const idle = !t || t.status === 'idle'
  const label = t ? timer.PHASE_LABEL[t.phase] : 'Focus'
  const left = t ? timer.remaining(t, now) : timer.phaseMs('focus', mirror?.settings ?? timer.DEFAULT_SETTINGS)

  return (
    <Card>
      <CardHeader
        title="Focus timer"
        description="The same timer as in Anemo: starting, pausing or skipping here changes it there too."
        actions={
          <a className="text-[12px] text-accent hover:underline" href={`${connection.serverUrl}/focus`} target="_blank" rel="noopener noreferrer">
            Open in Anemo
          </a>
        }
      />
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-baseline gap-3" data-testid="focus-timer">
          <span className={cn('font-mono text-[34px] font-semibold tabular-nums leading-none', t?.phase === 'focus' && running ? 'text-accent' : '')} aria-label="Time left">
            {timer.formatClock(left)}
          </span>
          <span className="text-[13px] text-muted">
            {label}
            {t?.status === 'paused' ? ' · paused' : idle ? ' · not started' : ''}
          </span>
        </div>
        {task && <p className="text-[12.5px] text-muted">On “{task.title}”</p>}

        {idle || t?.phase !== 'focus' ? (
          <div className="flex flex-col gap-2">
            <select
              aria-label="Task (optional)"
              className="h-9 w-full rounded-control border border-border bg-surface px-2 text-[13px]"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
            >
              <option value="">No task</option>
              {(tasks.data ?? []).slice(0, 200).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
            </select>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" icon={<Timer className="h-3.5 w-3.5" />} loading={busy === 'start'} onClick={() => void run('start', steps.startFocus(taskId || null))}>
                Start focus
              </Button>
              {!idle && t?.status === 'paused' && (
                <Button size="sm" icon={<Play className="h-3.5 w-3.5" />} loading={busy === 'resume'} onClick={() => void run('resume', steps.resume())}>
                  Resume break
                </Button>
              )}
              {!idle && running && (
                <Button size="sm" icon={<Pause className="h-3.5 w-3.5" />} loading={busy === 'pause'} onClick={() => void run('pause', steps.pause())}>
                  Pause
                </Button>
              )}
              {!idle && (
                <Button size="sm" variant="ghost" icon={<SkipForward className="h-3.5 w-3.5" />} loading={busy === 'skip'} onClick={() => void run('skip', steps.skip())}>
                  Skip break
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {running ? (
              <Button size="sm" icon={<Pause className="h-3.5 w-3.5" />} loading={busy === 'pause'} onClick={() => void run('pause', steps.pause())}>
                Pause
              </Button>
            ) : (
              <Button variant="primary" size="sm" icon={<Play className="h-3.5 w-3.5" />} loading={busy === 'resume'} onClick={() => void run('resume', steps.resume())}>
                Resume
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<SkipForward className="h-3.5 w-3.5" />} loading={busy === 'skip'} onClick={() => void run('skip', steps.skip())}>
              Skip to break
            </Button>
            <Button size="sm" variant="ghost" icon={<Square className="h-3.5 w-3.5" />} loading={busy === 'stop'} onClick={() => void run('stop', steps.stop())}>
              Stop
            </Button>
          </div>
        )}
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
      const ok = await chrome.permissions.request({ permissions: ['declarativeNetRequest'], origins: prefs.focusSites.flatMap(sitePatterns) }).catch(() => false)
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
        description="While a focus phase runs, these sites show the time left instead. Breaks and pauses are free. The only way out is stopping focus."
        actions={<Switch label="Block distractions during focus" checked={on} onChange={(v) => void toggle(v)} />}
      />
      <CardBody className="flex flex-col gap-2">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <Input aria-label="Site to block" placeholder="youtube.com" value={site} onChange={(e) => setSite(e.target.value)} />
          <Button type="submit" size="md" aria-label="Add site" icon={<Plus className="h-4 w-4" />} disabled={!site.trim()}>
            Add
          </Button>
        </form>
        {error && <p className="text-[12px] text-error">{error}</p>}
        {prefs.focusSites.length === 0 ? (
          <p className="text-[12.5px] text-muted">No sites yet. Chrome asks for access to each site you add.</p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Blocked sites">
            {prefs.focusSites.map((s) => (
              <li key={s} className="flex items-center gap-2 rounded-control border border-border px-3 py-1.5 text-[13px]">
                <ShieldBan className="h-3.5 w-3.5 shrink-0 text-subtle" />
                <span className="flex-1 truncate">{s}</span>
                {granted[s] === false && <span className="text-[11.5px] text-warning">no access</span>}
                <Button size="icon" variant="ghost" aria-label={`Remove ${s}`} onClick={() => void remove(s)} icon={<X className="h-3.5 w-3.5" />} />
              </li>
            ))}
          </ul>
        )}
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
