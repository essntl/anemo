import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../lib/cn'

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-card border border-border bg-card shadow-soft', className)} {...rest} />
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 pt-4">
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold">{title}</h3>
        {description && <p className="mt-0.5 text-[12.5px] text-muted">{description}</p>}
      </div>
      {actions}
    </div>
  )
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 py-4', className)} {...rest} />
}
