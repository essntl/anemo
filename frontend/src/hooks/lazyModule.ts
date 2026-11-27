import { useEffect, useState } from 'react'

/**
 * A hook for a module that is loaded only when a component needs it (a heavy library
 * that most screens never use). `load` runs once, on the first call with `needed`; a
 * failed load is tried again next time. Until it has loaded, the hook returns null.
 *
 *   const useMath = lazyModule(() => import('./math'))
 *   const math = useMath(text.includes('$'))
 */
export function lazyModule<M>(load: () => Promise<M>): (needed: boolean) => M | null {
  let loaded: M | null = null
  let loading: Promise<M> | null = null
  const start = () => {
    loading ??= load()
      .then((m) => (loaded = m))
      .catch((err: unknown) => {
        loading = null
        throw err
      })
    return loading
  }
  return function useLazyModule(needed: boolean): M | null {
    const [module, setModule] = useState<M | null>(loaded)
    useEffect(() => {
      if (!needed || module) return
      let live = true
      start()
        .then((m) => live && setModule(m))
        .catch(() => undefined)
      return () => {
        live = false
      }
    }, [needed, module])
    return needed ? module : null
  }
}
