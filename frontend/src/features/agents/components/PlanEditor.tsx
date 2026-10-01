import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { EditableStep } from '../plan'

const MAX_STEPS = 30

/** Edit a plan's steps: rename, reorder, remove and add. Steps keep their status. */
export function PlanEditor({ steps, onChange }: { steps: EditableStep[]; onChange: (steps: EditableStep[]) => void }) {
  const update = (i: number, title: string) => onChange(steps.map((s, j) => (j === i ? { ...s, title } : s)))
  const move = (i: number, by: number) => {
    const next = [...steps]
    const [step] = next.splice(i, 1)
    next.splice(i + by, 0, step)
    onChange(next)
  }
  const iconButton =
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-text disabled:opacity-30 pointer-coarse:h-10 pointer-coarse:w-10'

  return (
    <div className="flex flex-col gap-1.5">
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-1">
          <span className="w-5 shrink-0 text-right text-[12px] text-subtle">{i + 1}.</span>
          <input
            value={step.title}
            maxLength={200}
            aria-label={`Step ${i + 1}`}
            onChange={(e) => update(i, e.target.value)}
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 text-[13px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft pointer-coarse:h-10"
          />
          <button type="button" aria-label="Move up" className={iconButton} disabled={i === 0} onClick={() => move(i, -1)}>
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label="Move down" className={iconButton} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label="Remove step" className={iconButton} disabled={steps.length === 1}
            onClick={() => onChange(steps.filter((_, j) => j !== i))}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div>
        <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} disabled={steps.length >= MAX_STEPS}
          onClick={() => onChange([...steps, { title: '', status: 'pending' }])}>
          Add step
        </Button>
      </div>
    </div>
  )
}
