/**
 * The animation features of `motion` (animations, gestures, drag, layout), loaded
 * after the first paint by <LazyMotion> in app/App.tsx. Components use `m.div`
 * instead of `motion.div`, so the ~120 kB of features are not in the initial bundle;
 * until they arrive an element just shows its final state.
 */
export { domMax as default } from 'motion/react'
