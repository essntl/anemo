/**
 * Ambient sound made in the browser with Web Audio (no files, no network): rain,
 * ocean and three colours of noise, layered under the music with its own volume.
 * The choice of sound and the volume are kept on this device; it always starts off
 * (browsers only allow sound to start from a click).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AmbientKind = 'rain' | 'ocean' | 'brown' | 'pink' | 'white'

export const AMBIENT_KINDS: { id: AmbientKind; label: string }[] = [
  { id: 'rain', label: 'Rain' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'brown', label: 'Brown' },
  { id: 'pink', label: 'Pink' },
  { id: 'white', label: 'White' },
]

interface AmbientState {
  enabled: boolean
  kind: AmbientKind
  volume: number
}

export const useAmbient = create<AmbientState>()(
  persist((): AmbientState => ({ enabled: false, kind: 'rain', volume: 0.4 }), {
    name: 'anemo-ambient',
    partialize: (s) => ({ kind: s.kind, volume: s.volume }),
  }),
)

let ctx: AudioContext | null = null
let master: GainNode | null = null
let graph: { stop: () => void } | null = null
let currentKind: AmbientKind | null = null

function noiseBuffer(ac: AudioContext, kind: 'white' | 'pink' | 'brown'): AudioBuffer {
  const length = ac.sampleRate * 4
  const buffer = ac.createBuffer(2, length, ac.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1
      if (kind === 'white') data[i] = white * 0.35
      else if (kind === 'pink') {
        b0 = 0.99886 * b0 + white * 0.0555179
        b1 = 0.99332 * b1 + white * 0.0750759
        b2 = 0.969 * b2 + white * 0.153852
        b3 = 0.8665 * b3 + white * 0.3104856
        b4 = 0.55 * b4 + white * 0.5329522
        b5 = -0.7616 * b5 - white * 0.016898
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11
        b6 = white * 0.115926
      } else {
        last = (last + 0.02 * white) / 1.02
        data[i] = last * 3.5
      }
    }
  }
  return buffer
}

function build(ac: AudioContext, out: AudioNode, kind: AmbientKind): { stop: () => void } {
  const src = ac.createBufferSource()
  src.loop = true
  const nodes: AudioNode[] = []
  const oscs: OscillatorNode[] = []

  if (kind === 'rain' || kind === 'ocean') {
    const rain = kind === 'rain'
    src.buffer = noiseBuffer(ac, rain ? 'pink' : 'brown')
    const lp = ac.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = rain ? 6000 : 900
    const gain = ac.createGain()
    gain.gain.value = rain ? 0.8 : 0.55
    // Rain flutters like drops on a window; the ocean swells slowly.
    const lfo = ac.createOscillator()
    lfo.frequency.value = rain ? 0.35 : 0.09
    const lfoGain = ac.createGain()
    lfoGain.gain.value = rain ? 0.12 : 0.45
    lfo.connect(lfoGain).connect(gain.gain)
    if (rain) {
      const hp = ac.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 400
      src.connect(hp).connect(lp).connect(gain).connect(out)
      nodes.push(hp)
    } else {
      src.connect(lp).connect(gain).connect(out)
    }
    nodes.push(lp, gain, lfoGain)
    oscs.push(lfo)
  } else {
    src.buffer = noiseBuffer(ac, kind)
    src.connect(out)
  }

  src.start()
  oscs.forEach((o) => o.start())
  return {
    stop() {
      try {
        src.stop()
        oscs.forEach((o) => o.stop())
      } catch {
        // already stopped
      }
      src.disconnect()
      nodes.forEach((n) => n.disconnect())
    },
  }
}

/** Bring the sound in line with the state. Starts sound, so the first call must come from a click. */
function sync(state: AmbientState) {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return
  if (!state.enabled) {
    if (master && ctx) master.gain.setTargetAtTime(0, ctx.currentTime, 0.15)
    setTimeout(() => {
      if (useAmbient.getState().enabled) return
      graph?.stop()
      graph = null
      currentKind = null
      void ctx?.suspend()
    }, 600)
    return
  }
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = 0
    master.connect(ctx.destination)
  }
  void ctx.resume()
  if (currentKind !== state.kind) {
    graph?.stop()
    graph = build(ctx, master!, state.kind)
    currentKind = state.kind
  }
  master!.gain.setTargetAtTime(state.volume * 0.6, ctx.currentTime, 0.2)
}

export const ambientActions = {
  toggle() {
    useAmbient.setState((s) => ({ enabled: !s.enabled }))
    sync(useAmbient.getState())
  },
  setKind(kind: AmbientKind) {
    useAmbient.setState({ kind, enabled: true })
    sync(useAmbient.getState())
  },
  setVolume(volume: number) {
    useAmbient.setState({ volume })
    sync(useAmbient.getState())
  },
}
