/**
 * The project and prompt being written in the New job dialog: kept while the dialog is
 * closed (Escape, a click outside), until a job starts or the page is loaded again.
 */
export const newJobDraft = { project: '', prompt: '' }

export function clearNewJobDraft(): void {
  newJobDraft.project = ''
  newJobDraft.prompt = ''
}
