import { useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import {
  AlertTriangle, Bot, Check, Coffee, ListPlus, Music, Repeat, ShieldQuestion, Shuffle, SkipForward, Timer,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { spring } from '@/lib/motion'
import type { AlertIcon, AlertTone } from './alerts'

const TONE: Record<AlertTone, string> = {
  accent: 'var(--accent)',
  success: 'var(--success)',
  info: 'var(--info)',
  warning: 'var(--warning)',
  error: 'var(--error)',
}

const ICONS: Record<AlertIcon, ReactNode> = {
  timer: <Timer />,
  coffee: <Coffee />,
  music: <Music />,
  plus: <ListPlus />,
  skip: <SkipForward />,
  bot: <Bot />,
  approval: <ShieldQuestion />,
  warning: <AlertTriangle />,
  check: <Check />,
  shuffle: <Shuffle />,
  repeat: <Repeat />,
}

/** A round control on the Island; `big` is the white play/pause button. */
export function IslandButton({ label, onClick, children, big }: { label: string; onClick: () => void; children: ReactNode; big?: boolean }) {
  return (
    <motion.button type="button" aria-label={label} title={label} whileTap={{ scale: 0.88 }} transition={spring.snappy}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn('flex shrink-0 items-center justify-center rounded-full transition-colors',
        big ? 'h-10 w-10 bg-island-fg text-island hover:opacity-90 [&_svg]:h-[18px] [&_svg]:w-[18px]'
          : 'h-9 w-9 bg-island-control text-island-fg hover:bg-island-control-hover [&_svg]:h-4 [&_svg]:w-4',
        'pointer-coarse:h-11 pointer-coarse:w-11')}>
      {children}
    </motion.button>
  )
}

/** The picture of an alert: artwork when there is one (and it loads), else its icon. */
export function AlertBadge({ icon, image, tone }: { icon?: AlertIcon; image?: string | null; tone: AlertTone }) {
  const [failed, setFailed] = useState(false)
  if (image && !failed) {
    return <img src={image} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(true)}
      className="h-9 w-9 shrink-0 rounded-xl object-cover ring-1 ring-island-ring" />
  }
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full [&>svg]:h-[18px] [&>svg]:w-[18px]"
      style={{ background: `color-mix(in oklab, ${TONE[tone]} 32%, transparent)`, color: TONE[tone] }}>
      {ICONS[icon ?? 'check']}
    </span>
  )
}
