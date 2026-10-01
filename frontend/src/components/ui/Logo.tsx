import { useId } from 'react'

/**
 * The Anemo mark: three streams of wind that fade in from the left.
 * It is drawn in the current text colour, so `text-accent` or `text-text` set its colour.
 * The app icons use the same shapes: see e2e/scripts/make-icons.cjs.
 */
export function Logo({ className }: { className?: string }) {
  const fade = useId()
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={fade} gradientUnits="userSpaceOnUse" x1="1" y1="0" x2="13" y2="0">
          <stop offset="0" stopColor="currentColor" stopOpacity="0" />
          <stop offset="1" stopColor="currentColor" />
        </linearGradient>
      </defs>
      <g fill="none" stroke={`url(#${fade})`} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" transform="translate(0.75 1.5)">
        <path d="M5 8h7.5a2.5 2.5 0 1 0-2.5-2.5" />
        <path d="M1.5 12h16a3 3 0 1 1-3 3" />
        <path d="M4 16h6.5" />
      </g>
    </svg>
  )
}
