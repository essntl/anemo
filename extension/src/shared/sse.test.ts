import { afterEach, describe, expect, it, vi } from 'vitest'
import { readStream, SseParser, type SseEvent } from './sse'

describe('SseParser', () => {
  it('parses events split across chunks, ids, comments and multi-line data', () => {
    const p = new SseParser()
    expect(p.push('id: 1-0\nevent: message.delta\nda')).toEqual([])
    expect(p.push('ta: {"text":"Hel"}\n\n: ping\n\n')).toEqual([{ id: '1-0', type: 'message.delta', data: '{"text":"Hel"}' }])
    expect(p.push('event: x\r\ndata: a\r\ndata: b\r\n\r\n')).toEqual([{ id: '1-0', type: 'x', data: 'a\nb' }])
    expect(p.push('data: plain\n\n')).toEqual([{ id: '1-0', type: 'message', data: 'plain' }])
  })
})

function streamResponse(text: string): Response {
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close() } }), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

afterEach(() => vi.restoreAllMocks())

describe('readStream', () => {
  it('reconnects after a drop and resumes from the last id', async () => {
    const calls: (string | null)[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push(headers['Last-Event-ID'] ?? null)
      if (calls.length === 1) return streamResponse('id: 1\nevent: message.delta\ndata: {"text":"a"}\n\n') // then drops
      return streamResponse('id: 2\nevent: run.status\ndata: {"status":"completed"}\n\n')
    })
    const seen: SseEvent[] = []
    await readStream({
      url: 'https://a.example/api/runs/r/events',
      headers: { Authorization: 'Bearer t' },
      signal: new AbortController().signal,
      onEvent: (e) => seen.push(e),
      isEnd: (e) => e.type === 'run.status',
      backoffMs: () => 0,
    })
    expect(calls).toEqual([null, '1'])
    expect(seen.map((e) => e.type)).toEqual(['message.delta', 'run.status'])
  })

  it('stops when onError gives up', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    const attempts: number[] = []
    await readStream({
      url: 'x', headers: {}, signal: new AbortController().signal, onEvent: () => undefined,
      onError: (_e, n) => { attempts.push(n); return n < 3 },
      backoffMs: () => 0,
    })
    expect(attempts).toEqual([1, 2, 3])
  })

  it('stops at once when aborted', async () => {
    const controller = new AbortController()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    })
    const onError = vi.fn(() => true)
    await readStream({ url: 'x', headers: {}, signal: controller.signal, onEvent: () => undefined, onError })
    expect(onError).not.toHaveBeenCalled()
  })
})
