import { Construction } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'

/** Stand-in for screens delivered in later implementation phases. */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="text-xl font-semibold">{title}</h1>
      <EmptyState
        icon={<Construction className="h-5 w-5" />}
        title="Coming in a later phase"
        description="This area is part of the plan but not built yet."
      />
    </div>
  )
}
