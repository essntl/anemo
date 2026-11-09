/** In-page translate/explain for the mock Anemo. "Translation" upper-cases the text inside
 *  each marker (so markers and structure can be checked); explanations stream in pieces. */
import { send, type MockAnemo } from './mockAnemo'

export function addInline(anemo: MockAnemo) {
  const requests: { path: string; body: Record<string, unknown> }[] = []
  anemo.routes.set('POST /api/inline/translate', (_r, body, res) => {
    requests.push({ path: 'translate', body: body as Record<string, unknown> })
    const text = String((body as { text: string }).text)
    const out = /<\d+>/.test(text) ? text.replace(/<(\d+)>([\s\S]*?)<\/\1>/g, (_m, n: string, t: string) => `<${n}>${t.toUpperCase()}</${n}>`) : text.toUpperCase()
    send(res, 200, { text: out })
  })
  anemo.routes.set('POST /api/inline/explain', async (_r, body, res) => {
    requests.push({ path: 'explain', body: body as Record<string, unknown> })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const piece of ['**Photosynthesis** is how plants ', 'make sugar from light.\n\n', '| Word | Meaning |\n|---|---|\n| foto | light |']) {
      res.write(`event: delta\ndata: ${JSON.stringify({ text: piece })}\n\n`)
      await new Promise((r) => setTimeout(r, 30))
    }
    res.end('event: done\ndata: {}\n\n')
  })
  return { requests }
}
