import * as Popover from '@radix-ui/react-popover'
import { Info } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'

const CAPABILITY_LABELS: Record<string, string> = {
  tools: 'Tools',
  vision: 'Vision',
  reasoning: 'Reasoning',
  pdf: 'PDF',
  structured_output: 'JSON',
  embeddings: 'Embeddings',
}

export function CapabilityChips({ capabilities }: { capabilities: Record<string, boolean> }) {
  const on = Object.keys(CAPABILITY_LABELS).filter((k) => capabilities[k])
  if (on.length === 0) return <span className="text-[12px] text-subtle">Chat only</span>
  return (
    <div className="flex flex-wrap gap-1">
      {on.map((k) => (
        <Badge key={k} tone={k === 'reasoning' ? 'accent' : 'neutral'}>{CAPABILITY_LABELS[k]}</Badge>
      ))}
    </div>
  )
}

/**
 * The same tags behind one small button, for places where they would crowd out the
 * model's name (lists on a phone). Press it to see them.
 */
export function CapabilityInfo({ name, capabilities }: { name: string; capabilities: Record<string, boolean> }) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`What ${name} can do`}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text"
      >
        <Info className="h-4 w-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={4} collisionPadding={12}
          className="z-50 max-w-[16rem] rounded-card border border-border bg-card p-3 shadow-float">
          <CapabilityChips capabilities={capabilities} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
