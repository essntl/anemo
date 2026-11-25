import { useState } from 'react'
import { useMediaQuery } from '@/hooks/useMediaQuery'

/** Browser storage: "0" while the panel beside a document (outline, details, chat) is hidden. */
const INFO_PANEL = 'anemo.docInfo'
const WIDE = '(min-width: 1024px)'

/**
 * The panel beside the document. Wide screens: shown unless it was hidden, remembered on
 * this device. Narrower ones: it slides in over the document when asked for.
 */
export function useSidePanel() {
  const wide = useMediaQuery(WIDE)
  const [info, setInfo] = useState(() => { try { return localStorage.getItem(INFO_PANEL) !== '0' } catch { return true } })
  const [sheet, setSheet] = useState(false)
  const shown = wide ? info : sheet
  const toggle = () => {
    if (!wide) return setSheet(!sheet)
    try { localStorage.setItem(INFO_PANEL, info ? '0' : '1') } catch { /* no storage: just not remembered */ }
    setInfo(!info)
  }
  /** Shows it (if it isn't): e.g. to see what an action put there. */
  const show = () => {
    if (!shown) toggle()
  }
  return { wide, shown, toggle, show, sheet, setSheet, closeSheet: () => setSheet(false) }
}
export type SidePanelState = ReturnType<typeof useSidePanel>
