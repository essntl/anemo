import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeWav, toWav, WAV_RATE } from './wav'

async function view(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer())
}

function text(v: DataView, at: number, length: number): string {
  return Array.from({ length }, (_, i) => String.fromCharCode(v.getUint8(at + i))).join('')
}

function buffer(channels: number[][], sampleRate = WAV_RATE) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    getChannelData: (c: number) => Float32Array.from(channels[c]),
  }
}

function stubDecoder(decode: () => Promise<unknown>) {
  const made: number[][] = []
  vi.stubGlobal('OfflineAudioContext', class {
    constructor(...args: number[]) {
      made.push(args)
    }
    decodeAudioData = decode
  })
  return made
}

afterEach(() => vi.unstubAllGlobals())

describe('encodeWav', () => {
  it('writes a 16-bit mono WAV file', async () => {
    const blob = encodeWav(Float32Array.from([0, 1, -1, 0.5, 2, -2]), 16000)
    expect(blob.type).toBe('audio/wav')
    const v = await view(blob)
    expect(v.byteLength).toBe(44 + 12)
    expect(text(v, 0, 4)).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(36 + 12)
    expect(text(v, 8, 8)).toBe('WAVEfmt ')
    expect(v.getUint16(20, true)).toBe(1) // PCM
    expect(v.getUint16(22, true)).toBe(1) // mono
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint32(28, true)).toBe(32000)
    expect(v.getUint16(34, true)).toBe(16)
    expect(text(v, 36, 4)).toBe('data')
    expect(v.getUint32(40, true)).toBe(12)
    const samples = [0, 1, 2, 3, 4, 5].map((i) => v.getInt16(44 + i * 2, true))
    // Out-of-range samples are clipped, not wrapped around.
    expect(samples).toEqual([0, 32767, -32768, 16383, 32767, -32768])
  })
})

describe('toWav', () => {
  it('decodes the recording at 16 kHz and mixes the channels into one', async () => {
    const made = stubDecoder(async () => buffer([[0.5, 1], [-0.5, 0]]))
    const wav = await toWav(new Blob(['opus'], { type: 'audio/webm' }))
    expect(made).toEqual([[1, 1, WAV_RATE]])
    expect(wav.type).toBe('audio/wav')
    const v = await view(wav)
    expect(v.getUint32(24, true)).toBe(WAV_RATE)
    expect([v.getInt16(44, true), v.getInt16(46, true)]).toEqual([0, 16383])
  })

  it('keeps the recording as it is when the browser cannot decode it', async () => {
    stubDecoder(async () => {
      throw new Error('EncodingError')
    })
    const recording = new Blob(['opus'], { type: 'audio/webm' })
    expect(await toWav(recording)).toBe(recording)
  })

  it('keeps the recording as it is when nothing was decoded or decoding is missing', async () => {
    const recording = new Blob(['opus'], { type: 'audio/webm' })
    stubDecoder(async () => buffer([[]]))
    expect(await toWav(recording)).toBe(recording)
    vi.unstubAllGlobals()
    expect(await toWav(recording)).toBe(recording)
  })
})
