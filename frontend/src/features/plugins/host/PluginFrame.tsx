/**
 * One plugin UI in Anemo's page: the sandboxed frame and the host's end of its channel
 * (contract §6). Every slot (object panels, plugin pages, the settings tab, chat blocks,
 * previews) draws its plugin through this.
 *
 * How a frame starts:
 *   1. An <iframe sandbox="allow-scripts"> loads the one fixed frame document
 *      (/api/plugin-frame). No allow-same-origin: its origin is opaque, so it can't touch
 *      Anemo's cookies, storage or page, and its CSP blocks every network request.
 *   2. Meanwhile the plugin's files for this UI are fetched here, with the user's session
 *      (the frame itself can't fetch anything).
 *   3. The frame's bootstrap says `hello`. That message is only believed if it comes from
 *      this iframe's window (`event.source`): every sandboxed frame's origin is "null", so
 *      the origin can't tell frames apart.
 *   4. The host answers with `init` (the plugin, the slot, its context, the theme and the
 *      files) and hands over one end of a MessageChannel. From then on everything goes
 *      over that port; see channel.ts for the checks on every request.
 *   5. If the frame loads a second document (it navigated itself somewhere), it is removed
 *      at once and the plugin's page in Settings says so.
 *
 * Every frame also gets the screen's layout (`layout.changed`) and what the message box and
 * the assistant are doing (`composer.activity`, `assistant.activity`; states only), and is
 * listed in frames.ts so the plugin's other frames hear of its writes. A slot's place may add
 * its own events (`events`: the Code page's `code.job`). An overlay
 * (OverlayHost in overlays.tsx) is drawn without the box, the skeleton or the error card.
 */
import { type CSSProperties, type ReactNode, type Ref, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { TriangleAlert } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { toast } from '@/components/ui/toast'
import { documentLink, eventLink, taskLink } from '@/lib/appLinks'
import { cn } from '@/lib/cn'
import { currentLocale, t } from '@/lib/i18n'
import { assistantActivity, watchAssistantActivity } from '@/lib/assistantActivity'
import { settingsKey } from '@/features/settings/api'
import { callPlugin, fetchFrameBundle } from '../api'
import type { Slot } from '../types'
import { composerActivity, watchComposer } from './activity'
import { type ChannelOptions, clampHeight, PluginChannel } from './channel'
import { confirmPluginCall } from './confirm'
import { announceWrite, type OpenFrame, registerFrame } from './frames'
import { useFrameIncidents } from './incidents'
import { measureLayout, watchLayout } from './layout'
import { pickFile } from './pickFile'
import { currentTheme, watchTheme } from './theme'

/** The fixed frame document every plugin UI starts from (served by the backend). */
export const FRAME_URL = '/api/plugin-frame'
/** A frame whose bootstrap hasn't said hello by then didn't start. */
const HELLO_TIMEOUT_MS = 15_000
/** The height of a panel or block that doesn't say (contract: 40–800 to start with). */
const DEFAULT_HEIGHT = 160

export interface FramePlugin {
  id: string
  name: string
  iconUrl: string | null
  /** The version this frame runs: the approved one, or the one being previewed. */
  version: string
}

export interface PluginFrameProps {
  plugin: FramePlugin
  ui: string
  slot: Slot
  /** The permissions of `plugin.version`: the host's own check before every call. */
  permissions: readonly string[]
  /** The ids of the plugin's pages (what `ui.open({type: "page"})` may open). */
  pages?: readonly string[]
  /** What the slot is about (contract §3): sent with init and again when it changes. */
  context: unknown
  /** Whether the plugin may run (enabled or a preview; kill switch off). Checked on every call. */
  active: boolean
  /** Trying a version that isn't approved (contract §6.5). */
  preview?: boolean
  /** The starting height of a panel or block (40–800). */
  height?: number | null
  /** Take the whole height of the box it is in (a plugin page, the settings tab). */
  fill?: boolean
  /** Changes when the object shown was changed elsewhere: the frame is told to read it again. */
  revision?: string | number | null
  /** Shown instead of the frame until it has started, and if it can't (chat blocks: the code). */
  fallback?: ReactNode
  /** The frame's accessible name. */
  title?: string
  className?: string
  /** An overlay's own host methods (hit regions, visibility, the pointer reports). */
  overlay?: Pick<ChannelOptions, 'setHitRegions' | 'setVisible' | 'pointer'>
  /** The iframe element itself (an overlay switches its pointer events directly). */
  frameRef?: Ref<HTMLIFrameElement>
  /** Extra style for the iframe (an overlay's visibility). */
  frameStyle?: CSSProperties
  /**
   * Events of the slot's own place (the Code page's `code.job`): called once as the frame
   * starts with a function that sends one to it (dropped until it has started); returns a
   * function that stops them.
   */
  events?: (emit: (event: string, data: unknown) => void) => () => void
}

type Status = 'loading' | 'ready' | 'failed' | 'removed'

export function PluginFrame(props: PluginFrameProps) {
  const { plugin, ui, slot, context, preview = false, fill = false, revision, fallback, title, className, frameRef, frameStyle } = props
  const qc = useQueryClient()
  const navigate = useNavigate()
  const frame = useRef<HTMLIFrameElement>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [problem, setProblem] = useState<string | null>(null)
  const [height, setHeight] = useState(() => clampHeight(props.height ?? DEFAULT_HEIGHT))

  // The latest props, for the channel's callbacks (which outlive a render).
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  })
  const channel = useRef<PluginChannel | null>(null)
  const loads = useRef(0)

  // Steps 2–4: fetch the files, wait for hello from this frame, send init with the port.
  useEffect(() => {
    let cancelled = false
    let initSent = false
    let unregister = () => {}
    const bundle = fetchFrameBundle(qc, plugin.id, plugin.version, ui)
    // A failed fetch is shown once the frame is waiting for it (not as an unhandled rejection).
    bundle.catch(() => {})

    const fail = (message: string) => {
      if (cancelled) return
      setProblem(message)
      setStatus('failed')
    }
    const timer = window.setTimeout(() => !initSent && fail(t('The plugin didn’t start.')), HELLO_TIMEOUT_MS)

    const onMessage = async (event: MessageEvent) => {
      const win = frame.current?.contentWindow
      // Only this frame's own window may start it; anything else is ignored.
      if (!win || event.source !== win) return
      const data = event.data as { anemo?: unknown; type?: unknown } | null
      if (!data || data.anemo !== 1 || data.type !== 'hello' || initSent) return
      initSent = true
      window.clearTimeout(timer)
      let files
      try {
        files = await bundle
      } catch (err) {
        fail(errorMessage(err))
        return
      }
      if (cancelled) return
      const ports = new MessageChannel()
      const opened: OpenFrame = { pluginId: plugin.id, ui, emit: (event, data) => channel.current?.emit(event, data) }
      unregister = registerFrame(opened)
      channel.current = new PluginChannel(ports.port1, {
        ...latest.current.overlay,
        pluginId: plugin.id,
        ui,
        slot,
        permissions: latest.current.permissions,
        pages: latest.current.pages ?? [],
        previewVersion: preview ? plugin.version : null,
        active: () => latest.current.active,
        context: () => latest.current.context,
        call: (body) => callPlugin(plugin.id, body),
        confirm: (request) => confirmPluginCall({ id: plugin.id, name: plugin.name, iconUrl: plugin.iconUrl }, request),
        resize: setHeight,
        toast: (message) => toast({ message: `${plugin.name}: ${message}` }),
        open: (type, id) => {
          const to = type === 'task' ? taskLink(id) : type === 'document' ? documentLink(id) : type === 'event' ? eventLink(id) : `/plugins/${encodeURIComponent(plugin.id)}/${encodeURIComponent(id)}`
          void navigate(to)
        },
        pickFile,
        layout: () => measureLayout(),
        wrote: (area, key) => announceWrite(opened, area, key),
      })
      const init = {
        anemo: 1,
        type: 'init',
        plugin: { id: plugin.id, version: plugin.version },
        slot,
        ui,
        context: latest.current.context,
        theme: currentTheme(),
        locale: currentLocale(),
        layout: measureLayout(),
        timeZone: userTimeZone(qc.getQueryData(settingsKey)),
        preview,
        files,
      }
      // The frame's origin is opaque ("null"), so "*" is the only target that reaches it;
      // it is this exact window object, checked above.
      win.postMessage(init, '*', [ports.port2])
      // The states as they are now; later changes come as they happen.
      channel.current.emit('assistant.activity', { state: assistantActivity() })
      channel.current.emit('composer.activity', { state: composerActivity() })
      setStatus('ready')
    }

    window.addEventListener('message', onMessage)
    const emit = (event: string) => (data: unknown) => channel.current?.emit(event, data)
    const stopTheme = watchTheme(emit('theme.changed'))
    const stopLayout = watchLayout(emit('layout.changed'))
    const stopComposer = watchComposer((state) => channel.current?.emit('composer.activity', { state }))
    const stopAssistant = watchAssistantActivity((state) => channel.current?.emit('assistant.activity', { state }))
    const stopEvents = latest.current.events?.((event, data) => channel.current?.emit(event, data)) ?? (() => {})
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      stopTheme()
      stopLayout()
      stopComposer()
      stopAssistant()
      stopEvents()
      unregister()
      channel.current?.close()
      channel.current = null
    }
  }, [qc, navigate, plugin.id, plugin.name, plugin.iconUrl, plugin.version, ui, slot, preview])

  // The slot's object or the page's address changed: tell the frame.
  const contextKey = JSON.stringify(context ?? null)
  const sentContext = useRef(contextKey)
  useEffect(() => {
    if (sentContext.current === contextKey) return
    sentContext.current = contextKey
    channel.current?.emit('context.changed', latest.current.context)
  }, [contextKey])

  // The object was saved elsewhere: the frame should read it again.
  const sentRevision = useRef(revision)
  useEffect(() => {
    if (sentRevision.current === revision) return
    sentRevision.current = revision
    const object = (latest.current.context as { object?: unknown } | null)?.object ?? null
    channel.current?.emit('object.changed', object)
  }, [revision])

  // Step 5: the first load is the frame document; a second one means it navigated away.
  const onLoad = () => {
    loads.current += 1
    if (loads.current < 2) return
    channel.current?.close()
    channel.current = null
    setStatus('removed')
    useFrameIncidents.getState().report(plugin.id, ui)
  }

  if (slot === 'overlay') {
    // A transparent layer over the window: no box, no skeleton, no error card (a plugin that
    // can't start simply isn't drawn). OverlayHost places it and switches its pointer events.
    if (status !== 'loading' && status !== 'ready') return null
    return (
      <iframe
        // Both refs: this component's (the handshake checks the frame's window) and the host's.
        ref={(el) => {
          frame.current = el
          if (typeof frameRef === 'function') frameRef(el)
          else if (frameRef) frameRef.current = el
        }}
        src={FRAME_URL}
        sandbox="allow-scripts"
        allow=""
        referrerPolicy="no-referrer"
        title={title ?? plugin.name}
        onLoad={onLoad}
        // Never reached with Tab: an overlay can't take the keyboard from Anemo's page.
        tabIndex={-1}
        data-plugin-frame={plugin.id}
        style={{ pointerEvents: 'none', ...frameStyle }}
        className={cn('fixed inset-0 block h-full w-full border-0 bg-transparent', className)}
      />
    )
  }

  const box = fill ? { height: '100%' } : { height }
  const waiting = status === 'loading'
  // A chat block shows its code until the plugin has drawn, and again if it can't.
  const showFallback = fallback !== undefined && status !== 'ready'

  return (
    <div className={cn('relative', fill && 'h-full', className)} data-plugin-frame={plugin.id}>
      {showFallback && fallback}
      {(status === 'loading' || status === 'ready') && (
        <iframe
          ref={frame}
          src={FRAME_URL}
          // Scripts only: no same origin, forms, popups, top navigation, modals or downloads.
          sandbox="allow-scripts"
          // No camera, microphone, geolocation, clipboard… for the frame.
          allow=""
          referrerPolicy="no-referrer"
          title={title ?? plugin.name}
          onLoad={onLoad}
          style={showFallback ? { height } : box}
          className={cn(
            'block w-full border-0 bg-transparent transition-opacity duration-200 motion-reduce:transition-none',
            waiting ? 'opacity-0' : 'opacity-100',
            // Started out of sight while the fallback is shown.
            showFallback && 'pointer-events-none invisible absolute inset-x-0 top-0',
          )}
        />
      )}
      {waiting && fallback === undefined && (
        <div aria-hidden className="absolute inset-0 animate-pulse rounded-control bg-surface-2 motion-reduce:animate-none" />
      )}
      {(status === 'failed' || status === 'removed') && fallback === undefined && (
        <div role="status" className="flex h-full min-h-20 items-start gap-2 rounded-control border border-dashed border-border-strong p-3 text-[12.5px] text-muted" style={fill ? undefined : { minHeight: Math.min(height, 160) }}>
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            {status === 'removed'
              ? t('{name} tried to open another address inside its frame, so Anemo closed it.', { name: plugin.name })
              : t('{name} couldn’t be shown: {problem}', { name: plugin.name, problem: problem ?? '' })}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * The user's time zone (Settings > General), so a plugin's "today" is the same day the
 * server means; the browser's own zone while the settings aren't loaded. Read from the
 * query cache only: a frame shouldn't wait for, or cause, a settings request.
 */
function userTimeZone(settings: unknown): string {
  const zone = (settings as { general?: { timezone?: string } } | undefined)?.general?.timezone
  return zone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}
