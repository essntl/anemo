import { useEffect, useRef, useState } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react'
import { Download, ExternalLink, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { fade, spring } from '@/lib/motion'

interface Box { left: number; top: number; width: number; height: number }

/** Space kept free around the full-size image (toolbar above it, a margin below). */
const MARGIN = { x: 16, top: 64, bottom: 24 }

function boxOf(el: HTMLElement | null): Box | null {
  const r = el?.getBoundingClientRect()
  return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null
}

/** The image as large as fits the window (never above its own size), centred. */
function fitted(img: HTMLImageElement | null): Box {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const thumb = img?.getBoundingClientRect()
  const nw = img?.naturalWidth || thumb?.width || 1
  const nh = img?.naturalHeight || thumb?.height || 1
  const scale = Math.min(1, (vw - MARGIN.x * 2) / nw, (vh - MARGIN.top - MARGIN.bottom) / nh)
  const width = nw * scale
  const height = nh * scale
  return { left: (vw - width) / 2, top: MARGIN.top + (vh - MARGIN.top - MARGIN.bottom - height) / 2, width, height }
}

const iconButton =
  'flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur hover:bg-white/20 [&_svg]:h-[18px] [&_svg]:w-[18px]'

/**
 * A picture in the page (a chat attachment, what the agent saw) that opens large in
 * place: it grows out of its spot to fill the window, and shrinks back there when
 * closed (Esc, the close button, or a click anywhere). With reduced motion it fades.
 *
 *   <ZoomableImage src={url} alt="photo.png" className="max-h-48 rounded-xl" />
 */
export function ZoomableImage({ src, alt, className, title, filename }: {
  src: string
  alt: string
  /** For the small picture in the page. */
  className?: string
  title?: string
  /** Offered as the name when downloading. */
  filename?: string
}) {
  const thumb = useRef<HTMLImageElement>(null)
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)
  // The small picture stays hidden until the large one has shrunk back onto it.
  const [away, setAway] = useState(false)
  // Where the animation starts (opening) and ends (closing): the small picture's spot.
  const [from, setFrom] = useState<Box | null>(null)
  const [back, setBack] = useState<Box | null>(null)
  const [target, setTarget] = useState<Box | null>(null)

  useEffect(() => {
    if (!open) return
    const onResize = () => setTarget(fitted(thumb.current))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  const show = () => {
    const box = boxOf(thumb.current)
    if (!box) return
    setFrom(box)
    setTarget(fitted(thumb.current))
    setAway(true)
    setOpen(true)
  }
  const close = () => {
    setBack(boxOf(thumb.current) ?? from)
    setOpen(false)
  }

  const image: Variants = {
    small: (box: Box | null) =>
      reduce || !box ? { ...target, opacity: 0, borderRadius: 8 } : { ...box, opacity: 1, borderRadius: 12 },
    large: { ...target, opacity: 1, borderRadius: 8, transition: reduce ? fade : spring.smooth },
  }

  return (
    <>
      <button type="button" onClick={show} title={title} aria-label={`View ${alt}`}
        className="inline-block cursor-zoom-in rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        <img ref={thumb} src={src} alt={alt} className={cn(className, away && 'invisible')} />
      </button>

      <RadixDialog.Root open={open} onOpenChange={(next) => (next ? show() : close())}>
        <AnimatePresence custom={back} onExitComplete={() => setAway(false)}>
          {open && target && (
            <RadixDialog.Portal forceMount>
              <RadixDialog.Content forceMount aria-describedby={undefined} onClick={close}
                className="fixed inset-0 z-50 cursor-zoom-out focus:outline-none">
                <RadixDialog.Title className="sr-only">{alt}</RadixDialog.Title>
                <motion.div className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} />
                <motion.img src={src} alt={alt} draggable={false} custom={from} variants={image}
                  initial="small" animate="large" exit="small"
                  className="fixed max-w-none select-none object-cover shadow-float" />
                <motion.div className="absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] flex gap-2"
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}
                  onClick={(e) => e.stopPropagation()}>
                  <a href={src} target="_blank" rel="noreferrer" aria-label="Open in a new tab" title="Open in a new tab" className={iconButton}>
                    <ExternalLink />
                  </a>
                  <a href={src} download={filename ?? alt} aria-label="Download" title="Download" className={iconButton}>
                    <Download />
                  </a>
                  <RadixDialog.Close aria-label="Close" title="Close (Esc)" className={iconButton}>
                    <X />
                  </RadixDialog.Close>
                </motion.div>
              </RadixDialog.Content>
            </RadixDialog.Portal>
          )}
        </AnimatePresence>
      </RadixDialog.Root>
    </>
  )
}
