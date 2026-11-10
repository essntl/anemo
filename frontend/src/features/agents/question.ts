import type { ToolCallView } from './api'

/** What the agent asked (the ask_user tool), with its suggested answers. */
export function questionOf(call: ToolCallView) {
  return {
    question: String(call.args.question ?? call.approval?.summary ?? ''),
    options: ((call.args.options as string[] | undefined) ?? []).filter(Boolean),
    multiple: Boolean(call.args.multiple),
    answer: typeof call.args.answer === 'string' ? call.args.answer : null,
  }
}

/** The question this run is waiting on, if any. */
export function pendingQuestion(calls: ToolCallView[] | undefined): ToolCallView | undefined {
  return calls?.find((c) => c.approval?.kind === 'question' && c.approval.status === 'pending')
}

/** The tool call of this run that waits for a yes or no (not a plan to review or a question). */
export function pendingApproval(calls: ToolCallView[] | undefined): ToolCallView | undefined {
  return calls?.find((c) =>
    c.status === 'waiting_approval' && c.approval?.status === 'pending' && c.approval.kind !== 'plan' && c.approval.kind !== 'question')
}
