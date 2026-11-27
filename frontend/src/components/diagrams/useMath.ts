import { lazyModule } from '@/hooks/lazyModule'

/**
 * The Markdown plugins for math, once loaded. `needed` is false for texts without a `$`,
 * which never load KaTeX. Until it has loaded, a formula shows as its source.
 */
export const useMath = lazyModule(() => import('./math'))
