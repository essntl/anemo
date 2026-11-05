import { useEffect, useState } from 'react'

type MathModule = typeof import('./math')

let loaded: MathModule | null = null
let loading: Promise<MathModule> | null = null

function loadMath(): Promise<MathModule> {
  loading ??= import('./math')
    .then((m) => (loaded = m))
    .catch((err: unknown) => {
      loading = null
      throw err
    })
  return loading
}

/**
 * The Markdown plugins for math, once loaded. `needed` is false for texts without a `$`,
 * which never load KaTeX. Until it has loaded, a formula shows as its source.
 */
export function useMath(needed: boolean): MathModule | null {
  const [math, setMath] = useState<MathModule | null>(loaded)
  useEffect(() => {
    if (!needed || math) return
    let live = true
    loadMath()
      .then((m) => live && setMath(m))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [needed, math])
  return needed ? math : null
}
