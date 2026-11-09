import type { ReactNode } from 'react'
import { AlertTriangle, Info, WifiOff } from 'lucide-react'
import { cn } from '../lib/cn'

type Tone = 'info' | 'warning' | 'error' | 'offline'

const tones: Record<Tone, string> = {
  info: 'border-border bg-surface-2 text-text',
  warning: 'border-warning/30 bg-warning/10 text-text',
  error: 'border-error/30 bg-error/10 text-text',
  offline: 'border-border bg-surface-2 text-text',
}

const icons: Record<Tone, ReactNode> = {
  info: <Info className="h-4 w-4 text-info" />,
  warning: <AlertTriangle className="h-4 w-4 text-warning" />,
  error: <AlertTriangle className="h-4 w-4 text-error" />,
  offline: <WifiOff className="h-4 w-4 text-muted" />,
}

/** A short message in a box, with optional actions underneath. */
export function Notice({ tone = 'info', title, children, actions }: { tone?: Tone; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex gap-2.5 rounded-control border px-3 py-2.5', tones[tone])}>
      <div className="mt-0.5 shrink-0">{icons[tone]}</div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        {children && <div className="mt-0.5 text-[12.5px] text-muted">{children}</div>}
        {actions && <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  )
}
