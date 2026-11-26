import type { ToolCallView } from './api'

/** One item of a call that changes many things at once (update_tasks, update_events). */
export type BatchItem = { item: string; ref: string | null; risk: string }

/**
 * The items of a batch call, from its actions (the backend's `Action.item` and `.ref`):
 * empty for an ordinary call.
 */
export function batchItems(call: Pick<ToolCallView, 'actions'>): BatchItem[] {
  return call.actions.flatMap((a) =>
    typeof a.item === 'string'
      ? [{ item: a.item, ref: typeof a.ref === 'string' ? a.ref : null, risk: typeof a.risk === 'string' ? a.risk : 'safe' }]
      : [],
  )
}
