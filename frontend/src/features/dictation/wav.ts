/**
 * A recording as WAV: 16 kHz, mono, 16-bit, which is what Whisper models work on.
 * Every speech-to-text server takes it; the browser's own formats (Opus in WebM, MP4)
 * are refused by servers built on whisper.cpp, such as Lemonade.
 */

export const WAV_RATE = 16000

function ascii(view: DataView, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i))
}

/** Mono samples (-1 to 1) as a 16-bit WAV file. */
export function encodeWav(samples: Float32Array, rate: number): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2))
  ascii(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(view, 8, 'WAVE')
  ascii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // size of the format block
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // channels
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // bytes per second
  view.setUint16(32, 2, true) // bytes per sample
  view.setUint16(34, 16, true) // bits per sample
  ascii(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([view.buffer], { type: 'audio/wav' })
}

/** The channels of a decoded recording, averaged into one. */
function mono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0)
  const out = new Float32Array(buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < out.length; i++) out[i] += data[i] / buffer.numberOfChannels
  }
  return out
}

/**
 * The recording as WAV. If the browser can't decode what it recorded, the recording
 * comes back as it is, which servers that take the browser's format still accept.
 */
export async function toWav(recording: Blob): Promise<Blob> {
  if (!recording.size || typeof OfflineAudioContext === 'undefined') return recording
  try {
    // Decoding in a 16 kHz context also resamples to 16 kHz.
    const ctx = new OfflineAudioContext(1, 1, WAV_RATE)
    const decoded = await ctx.decodeAudioData(await recording.arrayBuffer())
    if (!decoded.length) return recording
    return encodeWav(mono(decoded), decoded.sampleRate)
  } catch {
    return recording
  }
}
