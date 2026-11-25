/**
 * Plugin overlays (slot "overlay", contract §3): for each enabled plugin with one, one
 * sandboxed frame as a transparent layer over the whole window. Mounted once in AppLayout,
 * outside the routed pages, so an overlay lives for the whole session and keeps its state
 * across navigation.
 *
 * The safety rules (an overlay is a surface for clickjacking and spoofing):
 *
 *  - It lets every click through (`pointer-events: none`), except while the pointer is in
 *    one of the hit regions it set (host/hitRegions.ts). On touch screens: always.
 *  - It is drawn above the page (z-index 35) but below every dialog, toast and the command
 *    palette (40 and up), and hidden altogether while any dialog, the opened Island or a
 *    plugin review is on screen (host/dialogWatch.ts).
 *  - Tab never moves into it, and the user can hide all overlays from Ctrl+K (overlayStore).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { useDialogOpen } from './host/dialogWatch'
import { HitRegions } from './host/hitRegions'
import { pokeLayout } from './host/layout'
import { PluginFrame } from './host/PluginFrame'
import { usePluginOverlays } from './overlayStore'
import { framePlugin, pagesOf, usePluginUis } from './slotData'
import type { ContributionUi } from './types'

const CONTEXT = { overlay: true }

/** One overlay frame and its pointer handling. */
function OverlayHost({ ui, pages, blocked }: { ui: ContributionUi; pages: string[]; blocked: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [visible, setVisible] = useState(true)
  const shown = visible && !blocked
  const [hits] = useState(() => new HitRegions())
  // Pointer events are switched on the element directly: on pointer moves, not renders.
  useEffect(() => {
    hits.bind((taking) => {
      if (frame.current) frame.current.style.pointerEvents = taking ? 'auto' : 'none'
    })
  }, [hits])

  // Where the pointer is while Anemo's page sees it (the frame reports it otherwise).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') hits.move({ x: e.clientX, y: e.clientY })
    }
    const onOut = (e: PointerEvent) => {
      if (!e.relatedTarget) hits.move(null)
    }
    window.addEventListener('pointermove', onMove, { capture: true, passive: true })
    window.addEventListener('pointerdown', onMove, { capture: true, passive: true })
    document.addEventListener('pointerout', onOut, true)
    return () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerdown', onMove, true)
      document.removeEventListener('pointerout', onOut, true)
    }
  }, [hits])

  useEffect(() => hits.setEnabled(shown), [hits, shown])

  const overlay = useMemo(
    () => ({
      setHitRegions: (regions: Parameters<HitRegions['set']>[0]) => hits.set(regions),
      setVisible: (v: boolean) => setVisible(v),
      pointer: (point: { x: number; y: number } | null) => hits.move(point),
    }),
    [hits],
  )

  return (
    <PluginFrame plugin={framePlugin(ui)} ui={ui.id} slot="overlay" permissions={ui.permissions} pages={pages}
      context={CONTEXT} active title={ui.title ?? ui.plugin_name} overlay={overlay} frameRef={frame}
      frameStyle={{ visibility: shown ? 'visible' : 'hidden' }}
      // Above the page, below dialogs (z-40/50), toasts (z-60) and the command palette.
      className="z-[35]" />
  )
}

/** Every enabled plugin's overlay (none while the user has hidden them). */
export function PluginOverlays() {
  const all = usePluginUis()
  const overlays = all.filter((u) => u.slot === 'overlay')
  const hidden = usePluginOverlays((s) => s.hidden)
  const setCount = usePluginOverlays((s) => s.setCount)
  const blocked = useDialogOpen()
  const { pathname } = useLocation()

  // A new route: every frame's layout (its `route`, and whatever moved) is measured again.
  useEffect(() => pokeLayout(), [pathname])
  useEffect(() => setCount(overlays.length), [overlays.length, setCount])

  if (hidden || overlays.length === 0) return null
  return (
    <>
      {overlays.map((ui) => (
        <OverlayHost key={`${ui.plugin}@${ui.version}/${ui.id}`} ui={ui} pages={pagesOf(all, ui.plugin)} blocked={blocked} />
      ))}
    </>
  )
}
