/** Plan steps as the UI edits them (the API sends plans as loosely typed JSON). */
export type StepStatus = 'pending' | 'in_progress' | 'done' | 'skipped'
export interface EditableStep {
  title: string
  status: StepStatus
}

/** Steps from the API (loosely typed JSON) as editable steps. */
export function toEditable(plan: Record<string, unknown>[] | null | undefined): EditableStep[] {
  return (plan ?? []).map((s) => ({
    title: String(s.title ?? ''),
    status: (['pending', 'in_progress', 'done', 'skipped'].includes(String(s.status)) ? s.status : 'pending') as StepStatus,
  }))
}

export const planIsValid = (steps: EditableStep[]) => steps.length > 0 && steps.every((s) => s.title.trim())
