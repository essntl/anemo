import { Badge } from '@/components/ui/Badge'

const LABELS: Record<string, string> = {
  tools: 'Tools',
  vision: 'Vision',
  reasoning: 'Reasoning',
  pdf: 'PDF',
  structured_output: 'JSON',
  embeddings: 'Embeddings',
}

export function CapabilityChips({ capabilities }: { capabilities: Record<string, boolean> }) {
  const on = Object.keys(LABELS).filter((k) => capabilities[k])
  if (on.length === 0) return <span className="text-[12px] text-subtle">Chat only</span>
  return (
    <div className="flex flex-wrap gap-1">
      {on.map((k) => (
        <Badge key={k} tone={k === 'reasoning' ? 'accent' : 'neutral'}>{LABELS[k]}</Badge>
      ))}
    </div>
  )
}
