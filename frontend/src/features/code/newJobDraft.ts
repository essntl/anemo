import type { CodeImage } from './codeImages'

/**
 * The project, prompt and images being written in the New job dialog: kept while the
 * dialog is closed (Escape, a click outside), until a job starts or the page is loaded again.
 */
export const newJobDraft: { project: string; prompt: string; images: CodeImage[] } = { project: '', prompt: '', images: [] }

export function clearNewJobDraft(): void {
  newJobDraft.project = ''
  newJobDraft.prompt = ''
  newJobDraft.images = []
}
