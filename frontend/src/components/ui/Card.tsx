import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

/*
 * Padding comes from the density tokens (styles/tokens.css): --card-x and --card-y,
 * smaller with Settings > Appearance > Density > Compact.
 */

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // glass: translucent when Settings > Appearance > Frosted glass is on (styles/appearance.css).
      className={cn('glass rounded-card border border-border bg-card shadow-soft', className)}
      {...rest}
    />
  )
}

/**
 * A card's title and description, with its actions (a button, a switch) on the right,
 * centred against the text. Alone in a card it gets the bottom padding too, so the
 * description never touches the card's edge.
 */
export function CardHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-(--card-x) pt-(--card-y) last:pb-(--card-y)">
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        {description && <p className="mt-0.5 max-w-prose text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center">{actions}</div>}
    </div>
  )
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-(--card-x) py-(--card-y)', className)} {...rest} />
}
