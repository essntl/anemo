import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { addChat } from './mockChat'
import { addDocs } from './mockDocs'

const ID = 'dQw4w9WgXcQ'

/** 30 s of silence as WAV: something real to play, pause and seek. */
function wav(seconds = 30, rate = 8000): Buffer {
  const data = Buffer.alloc(seconds * rate)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('fmt ', 12)
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate, 28); head.writeUInt16LE(1, 32); head.writeUInt16LE(8, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data.fill(128)])
}

// A data URL: seekable (a routed response has no Range support, so no seeking).
const WATCH = `<!doctype html><html><head><title>Lecture 3: Thermodynamics - YouTube</title></head><body>
<div id="movie_player"><video src="data:audio/wav;base64,${wav(90).toString('base64')}" muted></video></div>
<ytd-watch-metadata><h1>Lecture 3: Thermodynamics</h1><ytd-channel-name><a href="/@mit">MIT OpenCourseWare</a></ytd-channel-name></ytd-watch-metadata>
<script>window.ytcfg = { get: (k) => ({ INNERTUBE_API_KEY: 'test-key', INNERTUBE_CONTEXT: { client: { clientName: 'WEB' } } })[k] }</script>
<script>var ytInitialData = {"engagementPanels":[{"x":{"getTranscriptEndpoint":{"params":"PARAMS123"}}}]};</script>
</body></html>`

const TRANSCRIPT = { actions: [{ updateEngagementPanelAction: { content: { transcriptRenderer: { content: { transcriptSearchPanelRenderer: { body: { transcriptSegmentListRenderer: { initialSegments: [0, 10, 20, 30, 40].map((s) => ({ transcriptSegmentRenderer: { startMs: String(s * 1000), endMs: String((s + 10) * 1000), snippet: { runs: [{ text: `Energy is conserved, part ${s}` }] } } })) } } } } } } } }] }

let docs: ReturnType<typeof addDocs>
let chat: ReturnType<typeof addChat>
let yt: Page
let transcriptAsked: string[]

test.beforeEach(async ({ panel, anemo, context }) => {
  chat = addChat(anemo)
  docs = addDocs(anemo)
  transcriptAsked = []
  await context.route('https://www.youtube.com/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/youtubei/v1/get_transcript') {
      transcriptAsked.push(route.request().postData() ?? '')
      return route.fulfill({ json: TRANSCRIPT })
    }
    return route.fulfill({ body: WATCH, contentType: 'text/html' })
  })
  await panel.getByLabel('Anemo address').fill(anemo.url)
  await panel.getByLabel('API token').fill('anemo_good-token')
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByText('What can I help with?')).toBeVisible()
  yt = await context.newPage()
  await yt.goto(`https://www.youtube.com/watch?v=${ID}&list=PL1`)
  await yt.evaluate(async () => {
    const v = document.querySelector('video')!
    if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }))
    await v.play()
  })
  await yt.bringToFront()
  await panel.getByRole('button', { name: 'Notes' }).click()
  await panel.getByRole('button', { name: 'Switch on' }).click()
  await expect(panel.getByTestId('video-title')).toHaveText('Lecture 3: Thermodynamics')
})

test('a note takes the time when you start typing, pauses the video, and lands in its document', async ({ panel }) => {
  await yt.evaluate(() => { document.querySelector('video')!.currentTime = 65 })
  await panel.getByRole('button', { name: 'Add note' }).click()
  await expect.poll(() => yt.evaluate(() => document.querySelector('video')!.paused)).toBe(true)
  await yt.evaluate(() => { document.querySelector('video')!.currentTime = 70 }) // time moves on before typing
  await panel.getByLabel('Note', { exact: true }).fill('**First law**: energy is conserved.')
  await expect(panel.getByTestId('note-composer')).toContainText('At 01:10')
  await panel.getByRole('button', { name: 'Save note' }).click()
  await expect(panel.getByRole('list', { name: 'Notes' })).toContainText('First law')
  // Playing again, as it was before the note.
  await expect.poll(() => yt.evaluate(() => document.querySelector('video')!.paused)).toBe(false)
  const doc = [...docs.docs.values()][0]
  expect(doc.folder).toBe('YouTube')
  expect(doc.content).toBe(`# Lecture 3: Thermodynamics\n\nChannel: MIT OpenCourseWare · [Watch on YouTube](https://youtu.be/${ID})\n\n## Notes\n\n[01:10](https://youtu.be/${ID}?t=70) **First law**: energy is conserved.\n`)
})

test('clicking a timestamp seeks the video; notes stay in time order; edit and delete', async ({ panel }) => {
  for (const [t, text] of [[20, 'later'], [5, 'earlier']] as const) {
    await yt.evaluate((s) => { document.querySelector('video')!.currentTime = s }, t)
    await panel.getByRole('button', { name: 'Add note' }).click()
    await panel.getByLabel('Note', { exact: true }).fill(text)
    await panel.getByRole('button', { name: 'Save note' }).click()
    await expect(panel.getByRole('list', { name: 'Notes' })).toContainText(text)
  }
  const items = panel.getByRole('list', { name: 'Notes' }).getByRole('listitem')
  await expect(items.nth(0)).toContainText('earlier')
  await items.nth(1).getByRole('button', { name: '00:20' }).click()
  await expect.poll(() => yt.evaluate(() => Math.round(document.querySelector('video')!.currentTime))).toBe(20)
  await items.nth(0).getByRole('button', { name: 'Edit note' }).click()
  await panel.getByLabel('Note', { exact: true }).fill('earlier, edited')
  await panel.getByRole('button', { name: 'Save note' }).click()
  await expect(items.nth(0)).toContainText('earlier, edited')
  panel.once('dialog', (d) => void d.accept())
  await items.nth(1).getByRole('button', { name: 'Delete note' }).click()
  await expect(items).toHaveCount(1)
  expect([...docs.docs.values()][0].content).not.toContain('later')
})

test('no timestamp is taken while an ad plays', async ({ panel }) => {
  await yt.evaluate(() => document.getElementById('movie_player')!.classList.add('ad-showing'))
  await panel.getByRole('button', { name: 'Add note' }).click()
  await panel.getByLabel('Note', { exact: true }).fill('during the ad')
  await expect(panel.getByTestId('note-composer')).toContainText('An ad is playing')
  await expect(panel.getByRole('button', { name: 'Save note' })).toBeDisabled()
  await yt.evaluate(() => {
    document.getElementById('movie_player')!.classList.remove('ad-showing')
    document.querySelector('video')!.currentTime = 12
  })
  await expect(panel.getByTestId('note-composer')).toContainText('At 00:12')
})

test('Explain this moment sends the transcript around it to a new chat', async ({ panel }) => {
  await yt.evaluate(() => { document.querySelector('video')!.currentTime = 25 })
  await yt.evaluate(() => document.querySelector('video')!.pause())
  await panel.getByRole('button', { name: 'Explain this moment' }).click()
  await expect(panel.getByTestId('assistant-message')).toContainText('You said: Explain what is said around 00:25')
  expect(JSON.parse(transcriptAsked[0])).toMatchObject({ params: 'PARAMS123' })
  const turn = chat.turns.at(-1) as { page: { source: string; url: string; content: string } }
  expect(turn.page.source).toBe('youtube')
  expect(turn.page.url).toBe(`https://youtu.be/${ID}?t=25`)
  expect(turn.page.content).toContain('[00:00] Energy is conserved, part 0')
  expect(turn.page.content).toContain('[00:40] Energy is conserved, part 40')
})

test('Shorts are not supported, and say so', async ({ panel }) => {
  await yt.goto(`https://www.youtube.com/shorts/${ID}`)
  await expect(panel.getByText('YouTube Shorts aren’t supported')).toBeVisible()
})

test('"Include this page" on a video attaches its transcript', async ({ panel }) => {
  await panel.getByRole('button', { name: 'Chat' }).click()
  await panel.getByRole('button', { name: 'Include this page' }).click()
  await expect(panel.getByTestId('page-chip')).toContainText('Lecture 3: Thermodynamics')
  await panel.getByLabel('Message').fill('summarize the lecture')
  await panel.getByLabel('Message').press('Enter')
  await expect(panel.getByTestId('assistant-message')).toContainText('You said: summarize the lecture')
  const turn = chat.turns.at(-1) as { page: { source: string; url: string; content: string } }
  expect(turn.page.source).toBe('youtube')
  expect(turn.page.url).toBe(`https://youtu.be/${ID}`)
  expect(turn.page.content).toMatch(/^Video: Lecture 3: Thermodynamics\nChannel: MIT OpenCourseWare\n\nTranscript:\n\[00:00\] Energy is conserved, part 0/)
})
