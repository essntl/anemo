/**
 * The hidden container the YouTube and SoundCloud player frames live in. It is
 * created once and stays in the page for the whole session (outside React, so no
 * page change can remove it), which is what keeps music playing across navigation.
 */
export function playerHost(): HTMLElement {
  let host = document.getElementById('anemo-player-host')
  if (!host) {
    host = document.createElement('div')
    host.id = 'anemo-player-host'
    host.setAttribute('aria-hidden', 'true')
    // Players must stay "visible" (YouTube pauses fully hidden ones): tiny, transparent, behind everything.
    Object.assign(host.style, {
      position: 'fixed',
      right: '0',
      bottom: '0',
      width: '200px',
      height: '200px',
      opacity: '0',
      pointerEvents: 'none',
      zIndex: '-1',
      overflow: 'hidden',
    })
    document.body.appendChild(host)
  }
  return host
}

const scripts = new Map<string, Promise<void>>()

/** Load a third-party script once (the YouTube and SoundCloud player APIs). */
export function loadScript(src: string): Promise<void> {
  let p = scripts.get(src)
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script')
      s.src = src
      s.async = true
      s.onload = () => resolve()
      s.onerror = () => {
        scripts.delete(src)
        reject(new Error(`Could not load ${src}`))
      }
      document.head.appendChild(s)
    })
    scripts.set(src, p)
  }
  return p
}
