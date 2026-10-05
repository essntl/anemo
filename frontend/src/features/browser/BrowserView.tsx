/**
 * The agent's browser for one conversation, live, and usable by you: click on the
 * picture, type, scroll, or enter an address. It is the same browser the agent
 * uses, so what you do (logging in, answering an "are you human" check) is there
 * for the agent afterwards.
 *
 * How it works: the picture is streamed live: the browser sends a new frame whenever
 * the page changes (see useBrowserStream). Without the stream it falls back to a
 * screenshot every second. Your clicks and keys are sent to the real browser, which
 * runs on the server.
 */
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Globe, RotateCw, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { confirmDialog } from '@/components/ui/dialogs'
import { cn } from '@/lib/cn'
import { useBrowserView, useCloseBrowser } from './api'
import { inputForKey, pagePoint } from './input'
import { useBrowserStream } from './useBrowserStream'
import { useInputQueue } from './useInputQueue'

interface Props {
  conversationId: string
  /** Extra buttons at the end of the toolbar (pop out, close panel). */
  actions?: ReactNode
  className?: string
}

/** Frame width to ask for: what the panel shows (sharp on high-density screens), in
 *  steps so resizing does not reconnect all the time; the browser itself is 1280 wide. */
function streamWidth(boxWidth: number): number {
  const wanted = boxWidth * Math.min(window.devicePixelRatio || 1, 2)
  return Math.min(1280, Math.max(320, Math.ceil(wanted / 160) * 160))
}

export function BrowserView({ conversationId, actions, className }: Props) {
  const close = useCloseBrowser(conversationId)
  const picture = useRef<HTMLImageElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1280)
  useEffect(() => {
    if (!box.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(streamWidth(entry.contentRect.width)))
    observer.observe(box.current)
    return () => observer.disconnect()
  }, [])
  // Streamed frames go straight into the <img> (no re-render per frame). React only
  // gets the first one, so the picture appears; while streaming its src stays put.
  const [firstFrame, setFirstFrame] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const queue = useInputQueue(conversationId, streaming)
  const view = useBrowserView(conversationId, true, streaming ? 5000 : 1000)
  // The address field shows the page's address unless you are typing in it.
  const [typedAddress, setTypedAddress] = useState<string | null>(null)
  const [touchText, setTouchText] = useState('')
  const data = view.data
  const open = Boolean(data?.open)
  useBrowserStream(conversationId, open, width, {
    onFrame: (jpeg) => {
      const src = `data:image/jpeg;base64,${jpeg}`
      if (picture.current) picture.current.src = src
      setFirstFrame((had) => had ?? src)
      setStreaming(true)
    },
    onStop: (reason) => {
      setStreaming(false)
      if (reason === 'closed') setFirstFrame(null) // no old picture next time
    },
  })
  const screenshot = data?.screenshot ? `data:image/jpeg;base64,${data.screenshot}` : null
  const shown = streaming && firstFrame ? firstFrame : (screenshot ?? firstFrame)

  /** A mouse position on the (scaled) picture as a position in the browser's page. */
  const pointAt = (clientX: number, clientY: number) =>
    pagePoint(picture.current!.getBoundingClientRect(), clientX, clientY, {
      width: data?.width ?? 1280,
      height: data?.height ?? 800,
    })

  const onKeyDown = (event: KeyboardEvent) => {
    const input = inputForKey(event)
    if (!input) return
    event.preventDefault()
    queue.push(input)
  }

  const go = (event: FormEvent) => {
    event.preventDefault()
    const url = (typedAddress ?? '').trim()
    if (url) queue.push({ kind: 'open', url })
    setTypedAddress(null)
  }

  const sendTouchText = (event: FormEvent) => {
    event.preventDefault()
    if (touchText) queue.push({ kind: 'type', text: touchText })
    setTouchText('')
  }

  const confirmClose = async () => {
    const ok = await confirmDialog({
      title: 'Close this browser?',
      message: 'Its pages, cookies and logins are gone. The agent starts with a fresh browser next time.',
      confirmLabel: 'Close browser',
      danger: true,
    })
    if (ok) close.mutate()
  }

  const error = queue.error ?? close.error ?? view.error

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-surface', className)}>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button size="icon" variant="ghost" aria-label="Back" disabled={!open} onClick={() => queue.push({ kind: 'back' })}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" aria-label="Reload" disabled={!open} onClick={() => queue.push({ kind: 'reload' })}>
          <RotateCw className={cn('h-4 w-4', queue.busy && 'animate-spin')} />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={go}>
          <input aria-label="Address" spellCheck={false} autoComplete="off" placeholder="Enter an address, e.g. example.com"
            disabled={data !== undefined && !data.available}
            value={typedAddress ?? data?.url ?? ''}
            onFocus={(e) => { setTypedAddress(data?.url ?? ''); e.target.select() }}
            onChange={(e) => setTypedAddress(e.target.value)}
            onBlur={() => setTypedAddress(null)}
            className="h-8 w-full rounded-control border border-border bg-bg px-2.5 text-[13px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft pointer-coarse:h-10" />
        </form>
        {open && (
          <Button size="icon" variant="ghost" aria-label="Close browser" loading={close.isPending} onClick={() => void confirmClose()}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
        {actions}
      </div>

      <div ref={box} className="min-h-0 flex-1 overflow-auto bg-bg" data-no-swipe>
        {data && !data.available && (
          <Message title="The browser is not running">
            Start it on the server with <code className="font-mono">docker compose --profile browser up -d</code>.
          </Message>
        )}
        {data?.available && !open && (
          <Message title="No page is open yet">
            When the agent opens a page in its browser, you see it here and can use it too. You can also enter an
            address above.
          </Message>
        )}
        {open && shown && (
          // The picture is the browser: clicks, the wheel and the keyboard go to the page.
          <div tabIndex={0} role="application" aria-label="The agent's browser. Click, type and scroll here."
            className="cursor-default outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              e.preventDefault()
              const text = e.clipboardData.getData('text')
              if (text) queue.push({ kind: 'type', text })
            }}>
            <img ref={picture} alt={data?.title || 'Browser page'} draggable={false}
              src={shown}
              className="block w-full select-none"
              onClick={(e) => queue.push({ kind: 'click', ...pointAt(e.clientX, e.clientY) })}
              onWheel={(e) => queue.push({ kind: 'scroll', dy: e.deltaY, ...pointAt(e.clientX, e.clientY) })} />
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3 py-2 text-[12px] text-muted">
        {error ? (
          <span className="text-error">{errorMessage(error)}</span>
        ) : open ? (
          <span className="flex items-center gap-1.5">
            <Globe className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              This is the agent’s browser. Click the page, then type; what you do stays for the agent.
            </span>
          </span>
        ) : (
          <span>One browser per chat, shared by you and the agent.</span>
        )}
        {/* Phones have no keyboard events on a picture: type here instead. */}
        {open && (
          <form className="mt-2 hidden gap-2 pointer-coarse:flex" onSubmit={sendTouchText}>
            <input aria-label="Text to type into the page" value={touchText} placeholder="Type into the page…"
              autoCapitalize="off" autoCorrect="off" onChange={(e) => setTouchText(e.target.value)}
              className="h-10 min-w-0 flex-1 rounded-control border border-border bg-bg px-2.5 focus:border-accent focus:outline-none" />
            <Button size="sm" variant="secondary" type="submit">Type</Button>
            <Button size="sm" variant="ghost" onClick={() => queue.push({ kind: 'key', key: 'Enter' })}>Enter</Button>
          </form>
        )}
      </div>
    </div>
  )
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <Globe className="h-5 w-5" />
      </div>
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-[13px] text-muted">{children}</p>
    </div>
  )
}
