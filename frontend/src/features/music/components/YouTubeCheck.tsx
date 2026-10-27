import { useRef, useState } from 'react'
import { CheckCircle2, Copy, Loader2, Play, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { toast } from '@/components/ui/toast'
import { cn } from '@/lib/cn'
import { EMBED_REFUSED, HOSTS, loadApi, mountIframe, type YTPlayer } from '../player/youtube'

/*
 * Finds out why YouTube refuses to play, on the user's own setup, by trying a video in
 * a few kinds of player. Comparing them tells apart a video whose owner blocks
 * embedding, a problem with the site's address or referrer, and a problem with the
 * hidden player Anemo uses.
 */

/** "Me at the zoo": public and embeddable for nearly 20 years. */
const REFERENCE = { id: 'jNQXAC9IVRw', label: 'Reference video (embedding allowed)' }

type Setup = 'visible' | 'nocookie' | 'background'
const SETUPS: { id: Setup; label: string }[] = [
  { id: 'visible', label: 'Normal YouTube player' },
  { id: 'nocookie', label: 'Privacy-enhanced player' },
  { id: 'background', label: "Anemo's background player" },
]

type Result = { state: 'running' } | { state: 'ok' } | { state: 'error'; code: number } | { state: 'timeout' }

function attempt(setup: Setup, videoId: string, stage: HTMLElement): Promise<Result> {
  return loadApi().then(
    (YT) =>
      new Promise<Result>((resolve) => {
        let player: YTPlayer | null = null
        let el: HTMLElement
        const done = (r: Result) => {
          clearTimeout(timer)
          try {
            player?.destroy()
          } catch {
            // gone
          }
          el.remove()
          resolve(r)
        }
        const timer = setTimeout(() => done({ state: 'timeout' }), 15_000)
        const events = {
          onReady: (e: { target: YTPlayer }) => {
            player = e.target
            e.target.mute()
            if (setup === 'background') e.target.loadVideoById(videoId)
            else e.target.playVideo()
          },
          onStateChange: (e: { data: number }) => e.data === 1 && done({ state: 'ok' }),
          onError: (e: { data: number }) => done({ state: 'error', code: e.data }),
        }
        if (setup === 'background') {
          // Exactly what the music player does: a hidden frame that loads videos later.
          el = mountIframe(HOSTS[0])
          new YT.Player(el, { events })
        } else {
          el = document.createElement('div')
          stage.appendChild(el)
          new YT.Player(el, {
            host: setup === 'nocookie' ? HOSTS[1] : HOSTS[0],
            videoId,
            width: 200,
            height: 112,
            playerVars: { playsinline: 1, mute: 1, autoplay: 1, origin: window.location.origin },
            events,
          })
        }
      }),
  )
}

function describe(r: Result | undefined): string {
  if (!r) return '—'
  if (r.state === 'running') return 'Testing…'
  if (r.state === 'ok') return 'Plays'
  if (r.state === 'timeout') return 'No answer from YouTube'
  return `Refused (code ${r.code})`
}

function environment(): [string, string][] {
  const host = window.location.hostname
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
  const meta = document.querySelector<HTMLMetaElement>('meta[name="referrer"]')?.content ?? 'browser default'
  return [
    ['Address', window.location.origin],
    ['Kind', host === 'localhost' || host === '127.0.0.1' ? 'this computer' : isIp ? 'IP address' : 'domain name'],
    ['Secure (HTTPS)', window.isSecureContext && window.location.protocol === 'https:' ? 'yes' : 'no'],
    ['Referrer policy', meta],
    ['Browser', navigator.userAgent],
  ]
}

export function YouTubeCheck({ open, onClose, songId, songTitle }: { open: boolean; onClose: () => void; songId?: string | null; songTitle?: string }) {
  const stage = useRef<HTMLDivElement>(null)
  const [results, setResults] = useState<Record<string, Result>>({})
  const [running, setRunning] = useState(false)
  const videos = [REFERENCE, ...(songId && songId !== REFERENCE.id ? [{ id: songId, label: songTitle ? `Your track: ${songTitle}` : 'Your track' }] : [])]

  async function run() {
    if (!stage.current) return
    setRunning(true)
    setResults({})
    for (const v of videos) {
      for (const s of SETUPS) {
        const key = `${v.id}:${s.id}`
        setResults((r) => ({ ...r, [key]: { state: 'running' } }))
        const res = await attempt(s.id, v.id, stage.current).catch((): Result => ({ state: 'timeout' }))
        setResults((r) => ({ ...r, [key]: res }))
      }
    }
    setRunning(false)
  }

  function report(): string {
    const lines = ['Anemo YouTube check', ...environment().map(([k, v]) => `${k}: ${v}`), '']
    for (const v of videos) {
      lines.push(`${v.label} (${v.id})`)
      for (const s of SETUPS) lines.push(`  ${s.label}: ${describe(results[`${v.id}:${s.id}`])}`)
    }
    return lines.join('\n')
  }

  const ref = (s: Setup) => results[`${REFERENCE.id}:${s}`]
  const refOk = (s: Setup) => ref(s)?.state === 'ok'
  const refusedRef = SETUPS.some((s) => {
    const r = ref(s.id)
    return r?.state === 'error' && EMBED_REFUSED.has(r.code)
  })
  const finished = !running && Object.keys(results).length > 0
  const verdict = !finished
    ? null
    : refOk('visible') && !refOk('background')
      ? "YouTube plays in a normal player but not in Anemo's background player. That points to the hidden player; copy these results into a bug report."
      : !refOk('visible') && refusedRef
        ? 'YouTube refuses even the reference video on this address. That points to the address or the browser (a blocker, or a proxy dropping the Referer header), not to your tracks.'
        : refOk('visible') && songId && results[`${songId}:visible`]?.state === 'error'
          ? "The reference video plays but your track doesn't, even in a normal player. Its owner doesn't allow playing it on other sites; nothing here can change that."
          : refOk('visible') && refOk('background')
            ? 'Everything plays here. If tracks still fail in the player, copy these results into a bug report.'
            : 'Mixed results. Copy these results into a bug report.'

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !running && onClose()} title="YouTube check" className="md:w-[min(92vw,520px)]"
      description="Plays a few seconds of muted video in different kinds of player to find out why YouTube refuses to play."
      footer={
        <>
          <Button variant="ghost" disabled={!finished} icon={<Copy className="h-4 w-4" />}
            onClick={async () => {
              await navigator.clipboard?.writeText(report()).catch(() => undefined)
              toast({ message: 'Results copied' })
            }}>
            Copy results
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={running}
            icon={running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}>
            {finished ? 'Run again' : 'Run check'}
          </Button>
        </>
      }>
      <div className="flex flex-col gap-4 text-[13.5px]">
        {videos.map((v) => (
          <div key={v.id}>
            <div className="mb-1 truncate text-[11.5px] font-semibold uppercase tracking-wider text-muted">{v.label}</div>
            <ul className="divide-y divide-border rounded-control border border-border">
              {SETUPS.map((s) => {
                const r = results[`${v.id}:${s.id}`]
                return (
                  <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span>{s.label}</span>
                    <span className={cn('flex items-center gap-1.5 text-[13px] font-medium',
                      r?.state === 'ok' ? 'text-success' : r?.state === 'error' || r?.state === 'timeout' ? 'text-error' : 'text-muted')}>
                      {r?.state === 'ok' ? <CheckCircle2 className="h-4 w-4" /> : r?.state === 'running' ? <Loader2 className="h-4 w-4 animate-spin" /> : r ? <XCircle className="h-4 w-4" /> : null}
                      {describe(r)}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
        {verdict && <p role="status" className="rounded-control bg-surface-2 p-3 text-[13px] font-medium">{verdict}</p>}
        {/* Visible players must really be on screen: YouTube doesn't allow hiding them. */}
        <div ref={stage} className="flex justify-center [&_iframe]:rounded-lg" />
      </div>
    </Dialog>
  )
}
