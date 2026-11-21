import { ApiError, type Schemas } from '@/api/client'
import { t } from '@/lib/i18n'

export type DictationResult = Schemas['DictationOut']
/** Where the text goes: a chat's message box, or any other text field. */
export type DictationKind = 'chat' | 'text'

/** Sends a recording to be transcribed and tidied. An upload, so `fetch` with a form (as for attachments). */
export async function transcribe(audio: Blob, kind: DictationKind, signal?: AbortSignal): Promise<DictationResult> {
  const form = new FormData()
  form.append('audio', audio, 'recording')
  form.append('target', kind)
  const res = await fetch('/api/dictation', { method: 'POST', body: form, credentials: 'same-origin', signal })
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
  if (!res.ok) {
    throw new ApiError(res.status, body.error?.code ?? `http_${res.status}`, body.error?.message ?? t('Dictation failed'))
  }
  return body as DictationResult
}
