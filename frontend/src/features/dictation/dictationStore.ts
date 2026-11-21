/**
 * Dictation, start to finish: record, send, put the text where you were typing
 * (docs/specs/04-dictation.md). One at a time for the whole app: the Caps Lock shortcut
 * and the microphone buttons all drive this.
 */
import { create } from 'zustand'
import { ApiError, errorMessage } from '@/api/client'
import { toast } from '@/components/ui/toast'
import { t } from '@/lib/i18n'
import { type DictationKind, transcribe } from './api'
import { insertText, type TextTarget, textTarget } from './insert'
import { type Recording, RecorderError, startRecording } from './recorder'

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'working'

interface DictationState {
  phase: DictationPhase
  /** When the recording started (ms since the epoch). */
  startedAt: number | null
}

export const useDictation = create<DictationState>(() => ({ phase: 'idle', startedAt: null }))

/** Recordings stop by themselves after this long. */
export const MAX_RECORDING_MS = 10 * 60 * 1000
/** Shorter than this is a slip of the finger, not something said. */
export const MIN_RECORDING_MS = 600

let recording: Recording | null = null
let target: TextTarget | null = null
let session = 0
let limit: ReturnType<typeof setTimeout> | undefined
let request: AbortController | null = null
/** The message boxes on screen, newest last: where text goes when no field had the focus. */
const messageBoxes: HTMLElement[] = []
let pendingText: string | null = null
let openPage: ((to: string) => void) | null = null

const set = (state: Partial<DictationState>) => useDictation.setState(state)

function reset() {
  clearTimeout(limit)
  recording = null
  request = null
  set({ phase: 'idle', startedAt: null })
}

function recorderMessage(err: unknown): string {
  const reason = err instanceof RecorderError ? err.reason : 'failed'
  switch (reason) {
    case 'insecure': return t('Dictation needs a secure connection: open Anemo over https (or on localhost).')
    case 'unsupported': return t('This browser can’t record audio.')
    case 'denied': return t('The browser didn’t allow the microphone. Allow it for this site, then try again.')
    case 'no_microphone': return t('No microphone was found.')
    default: return t('The microphone couldn’t be started.')
  }
}

/** Where the text goes now: the field you started in, else the newest message box on screen. */
function destination(): TextTarget | null {
  if (target?.isConnected) return target
  return [...messageBoxes].reverse().find((el) => el.isConnected) ?? null
}

function kindOf(dest: TextTarget | null): DictationKind {
  return !dest || dest.dataset.dictation === 'chat' ? 'chat' : 'text'
}

function deliver(text: string, dest: TextTarget | null) {
  if (dest) {
    insertText(dest, text)
    return
  }
  // No text field anywhere: a new chat, with the text in its message box.
  pendingText = text
  openPage?.('/')
}

export const dictation = {
  /** Starts recording. The text will go to `into`, or to the text field that has the focus. */
  async start(into?: TextTarget | null): Promise<void> {
    if (useDictation.getState().phase !== 'idle') return
    const mine = ++session
    target = into ?? textTarget(document.activeElement)
    set({ phase: 'starting' })
    let rec: Recording
    try {
      rec = await startRecording()
    } catch (err) {
      if (session === mine) {
        reset()
        toast({ message: recorderMessage(err) })
      }
      return
    }
    if (session !== mine) {
      rec.cancel() // cancelled while the browser asked for the microphone
      return
    }
    recording = rec
    set({ phase: 'recording', startedAt: Date.now() })
    limit = setTimeout(() => void dictation.finish(), MAX_RECORDING_MS)
  },

  /** Stops recording and puts the text in place. */
  async finish(): Promise<void> {
    const { phase, startedAt } = useDictation.getState()
    if (phase !== 'recording' || !recording) return
    const rec = recording
    const mine = session
    clearTimeout(limit)
    recording = null
    set({ phase: 'working' })
    const audio = await rec.stop()
    if (session !== mine) return
    if (Date.now() - (startedAt ?? 0) < MIN_RECORDING_MS || audio.size === 0) {
      reset()
      toast({ message: t('Nothing was recorded.') })
      return
    }
    const dest = destination()
    request = new AbortController()
    try {
      const result = await transcribe(audio, kindOf(dest), request.signal)
      if (session !== mine) return
      reset()
      if (!result.text.trim()) {
        toast({ message: t('Didn’t catch anything. Try again, a little closer to the microphone.') })
        return
      }
      deliver(result.text, destination() ?? dest)
      if (result.warning) toast({ message: t('The text couldn’t be tidied, so it is as it was heard.') })
    } catch (err) {
      if (session !== mine) return
      reset()
      const noModel = err instanceof ApiError && err.code === 'no_transcription_model'
      toast({
        message: noModel ? t('No speech-to-text model yet: choose one for Transcription in Settings.') : errorMessage(err),
        action: noModel ? { label: t('Choose a model'), onClick: () => openPage?.('/settings/providers') } : undefined,
      })
    }
  },

  /** Stops without using what was said. */
  cancel(): void {
    if (useDictation.getState().phase === 'idle') return
    session++
    recording?.cancel()
    request?.abort()
    reset()
  },

  /** Caps Lock twice: start, or finish what is being recorded. */
  toggle(): void {
    const { phase } = useDictation.getState()
    if (phase === 'idle') void dictation.start()
    else if (phase === 'recording') void dictation.finish()
  },

  /** How loud it is now, 0 to 1. */
  level(): number {
    return recording?.level() ?? 0
  },

  /** A message box is on screen. Returns the function that takes it off the list. */
  addMessageBox(el: HTMLElement): () => void {
    messageBoxes.push(el)
    return () => {
      const i = messageBoxes.lastIndexOf(el)
      if (i >= 0) messageBoxes.splice(i, 1)
    }
  },

  /** Text that waits for the next message box (a new chat opened for it). */
  takePendingText(): string | null {
    const text = pendingText
    pendingText = null
    return text
  },

  /** How to go to another page (set by DictationHost). */
  setOpenPage(fn: ((to: string) => void) | null): void {
    openPage = fn
  },
}
