import { Field, Input } from '@/components/ui/Input'
import type { Limits } from '../limits'

/** The limit inputs, shared by Settings > Agent Permissions and agent profiles. */
export function LimitsFields({ value, onChange }: { value: Limits; onChange: (limits: Limits) => void }) {
  const set = (patch: Partial<Limits>) => onChange({ ...value, ...patch })
  const num = (s: string) => Number(s) || 0
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="Max steps" hint="Model answers in one run">
        <Input type="number" min={1} value={value.max_steps} onChange={(e) => set({ max_steps: num(e.target.value) })} />
      </Field>
      <Field label="Max tool calls">
        <Input type="number" min={1} value={value.max_tool_calls} onChange={(e) => set({ max_tool_calls: num(e.target.value) })} />
      </Field>
      <Field label="Max minutes" hint="Working time; paused time does not count">
        <Input type="number" min={1} value={Math.round(value.max_runtime_s / 60)}
          onChange={(e) => set({ max_runtime_s: num(e.target.value) * 60 })} />
      </Field>
      <Field label="Max minutes per shell command">
        <Input type="number" min={1} max={60} value={Math.round(value.max_shell_timeout_s / 60)}
          onChange={(e) => set({ max_shell_timeout_s: num(e.target.value) * 60 })} />
      </Field>
      <Field label="Max cost (USD)" hint="Empty: no limit. Counts models with known prices.">
        <Input type="number" min={0} step={0.1} placeholder="No limit" value={value.max_cost_usd ?? ''}
          onChange={(e) => set({ max_cost_usd: e.target.value === '' ? null : Number(e.target.value) })} />
      </Field>
      <Field label="Stop after failures in a row" hint="Failed or blocked actions">
        <Input type="number" min={1} value={value.max_consecutive_errors}
          onChange={(e) => set({ max_consecutive_errors: num(e.target.value) })} />
      </Field>
      <Field label="Sub-agent levels" hint="1: sub-agents cannot start their own. Needs the “Start sub-agents” permission.">
        <Input type="number" min={0} max={3} value={value.max_subagent_depth}
          onChange={(e) => set({ max_subagent_depth: Math.min(3, Math.max(0, num(e.target.value))) })} />
      </Field>
    </div>
  )
}
