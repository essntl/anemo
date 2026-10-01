import type { Schemas } from '@/api/client'

export type Limits = Schemas['Limits']

/** Mirrors the backend defaults (policy/models.py Limits). */
export const DEFAULT_LIMITS: Limits = {
  max_steps: 25,
  max_tool_calls: 100,
  max_runtime_s: 1800,
  max_shell_timeout_s: 600,
  max_cost_usd: null,
  max_consecutive_errors: 5,
  max_subagent_depth: 1,
}
