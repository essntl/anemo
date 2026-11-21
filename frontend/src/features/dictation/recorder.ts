/**
 * Recording from the microphone, with a level for the meter. The browser records in
 * its own format (Opus in WebM in Chrome and Firefox, MP4 in Safari); what comes out
 * is WAV, which every speech-to-text server takes (see wav.ts).
 */

import { toWav } from './wav'

const FORMATS = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

export type RecorderFailure = 'unsupported' | 'insecure' | 'denied' | 'no_microphone' | 'failed'

export class RecorderError extends Error {
  readonly reason: RecorderFailure

  constructor(reason: RecorderFailure, message: string) {
    super(message)
    this.reason = reason
  }
}

export interface Recording {
  /** Stops and returns what was recorded, as WAV where the browser can convert it. */
  stop: () => Promise<Blob>
  /** Stops and throws the recording away. */
  cancel: () => void
  /** How loud it is now, from 0 to 1. */
  level: () => number
}

/** Whether this browser can record at all (it needs a secure page: https or localhost). */
export function canRecord(): boolean {
  return typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
}

function pickFormat(): string | undefined {
  return FORMATS.find((f) => MediaRecorder.isTypeSupported?.(f))
}

async function openMicrophone(): Promise<MediaStream> {
  if (!window.isSecureContext) throw new RecorderError('insecure', 'insecure')
  if (!canRecord()) throw new RecorderError('unsupported', 'unsupported')
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  } catch (err) {
    const name = err instanceof DOMException ? err.name : ''
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new RecorderError('denied', name)
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new RecorderError('no_microphone', name)
    throw new RecorderError('failed', err instanceof Error ? err.message : String(err))
  }
}

/** A level meter on the stream; returns a reader and a function that closes it. */
function meter(stream: MediaStream): { read: () => number; close: () => void } {
  try {
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    ctx.createMediaStreamSource(stream).connect(analyser)
    const data = new Uint8Array(analyser.fftSize)
    return {
      read: () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (const v of data) sum += ((v - 128) / 128) ** 2
        // Speech sits around 0.02-0.2 RMS: stretch that over the meter.
        return Math.min(1, Math.sqrt(sum / data.length) * 5)
      },
      close: () => void ctx.close().catch(() => {}),
    }
  } catch {
    return { read: () => 0, close: () => {} }
  }
}

export async function startRecording(): Promise<Recording> {
  const stream = await openMicrophone()
  const format = pickFormat()
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, format ? { mimeType: format } : undefined)
  } catch (err) {
    stream.getTracks().forEach((track) => track.stop())
    throw new RecorderError('failed', err instanceof Error ? err.message : String(err))
  }
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  const level = meter(stream)
  const release = () => {
    stream.getTracks().forEach((track) => track.stop())
    level.close()
  }
  recorder.start(1000)

  return {
    level: level.read,
    stop: () =>
      new Promise<Blob>((resolve) => {
        const done = () => {
          release()
          void toWav(new Blob(chunks, { type: recorder.mimeType || format || 'audio/webm' })).then(resolve)
        }
        recorder.onstop = done
        if (recorder.state === 'inactive') done()
        else recorder.stop()
      }),
    cancel: () => {
      recorder.onstop = release
      if (recorder.state === 'inactive') release()
      else recorder.stop()
    },
  }
}
