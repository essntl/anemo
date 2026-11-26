/**
 * When an overlay frame takes the pointer (contract: `ui.setHitRegions`).
 *
 * An overlay covers the whole window and lets every click through (`pointer-events: none`),
 * except while the pointer is inside one of the rectangles the plugin named. The host
 * knows where the pointer is from two sources, and either one is enough to decide:
 *
 *  - Anemo's page sees the pointer move while the frame doesn't take it;
 *  - while the frame does, the page sees nothing, so the frame's bootstrap (code of
 *    Anemo's, running before the plugin's) reports the position over the port.
 *
 * The pointer leaving the window (or the frame's report of that) lets clicks through again.
 * Regions changing while the pointer stands still are checked against its last position.
 * No region: always click-through.
 *
 * Touch screens have no pointer that moves before a tap, so touches are never reported:
 * on a touch screen an overlay is always click-through (a limitation of v1).
 */
import { inRegions } from './channel'
import type { Rect } from './layout'

export class HitRegions {
  private regions: Rect[] = []
  private point: { x: number; y: number } | null = null
  private taking = false
  private enabled = true
  private apply: (taking: boolean) => void

  /** `apply(true)`: the frame should take the pointer now; false: let it through. */
  constructor(apply: (taking: boolean) => void = () => {}) {
    this.apply = apply
  }

  /** Where the decision goes (set once the frame element exists); applied at once. */
  bind(apply: (taking: boolean) => void): void {
    this.apply = apply
    apply(this.taking)
  }

  /** The plugin's regions (checked by the channel). */
  set(regions: Rect[]): void {
    this.regions = regions
    this.update()
  }

  /** Where the pointer is, in viewport pixels; null when it left the window. */
  move(point: { x: number; y: number } | null): void {
    this.point = point
    this.update()
  }

  /** Off while the overlay is hidden (a dialog is open, or it hid itself). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.update()
  }

  get isTaking(): boolean {
    return this.taking
  }

  private update(): void {
    const taking = this.enabled && this.point !== null && inRegions(this.regions, this.point.x, this.point.y)
    if (taking === this.taking) return
    this.taking = taking
    this.apply(taking)
  }
}
