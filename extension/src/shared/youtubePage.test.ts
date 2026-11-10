import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTranscriptRaw } from './youtubePage'
import { segmentsFromRaw } from './youtube'

const ID = 'abcdefghijk'

function at(path: string) {
  window.history.replaceState(null, '', path)
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  const w = window as unknown as Record<string, unknown>
  delete w.ytcfg
  delete w.ytInitialData
  delete w.ytInitialPlayerResponse
})

describe('reading the transcript in a YouTube tab', () => {
  it('reads an open transcript panel in YouTube’s newer layout, without asking YouTube', async () => {
    at(`/watch?v=${ID}`)
    document.body.innerHTML = `
      <div id="movie_player"><div class="ytp-time-display"><span>0:12</span> / <span>12:34</span></div></div>
      <ytd-engagement-panel-section-list-renderer target-id="PAmodern_transcript_view">
        <div id="header"><h2>Transcript</h2><input placeholder="Search transcript"></div>
        <div id="content">
          ${[['2:51', 'there was a time when'], ['2:57', 'everyone talked about it'], ['1:03:05', 'and then it stopped']]
            .map(([t, line]) => `<transcript-segment-view-model><div class="ytwTranscriptSegmentViewModelTimestamp">${t}</div><span class="yt-core-attributed-string">${line}</span></transcript-segment-view-model>`)
            .join('')}
        </div>
      </ytd-engagement-panel-section-list-renderer>`
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const raw = await fetchTranscriptRaw(ID)
    expect(fetch).not.toHaveBeenCalled()
    expect(segmentsFromRaw(raw)).toEqual([
      { start: 171, end: 177, text: 'there was a time when' },
      { start: 177, end: 3785, text: 'everyone talked about it' },
      { start: 3785, end: 3790, text: 'and then it stopped' },
    ])
  })

  it('reads the older panel layout', async () => {
    at(`/watch?v=${ID}`)
    document.body.innerHTML = `<ytd-transcript-segment-renderer><div class="segment-timestamp"> 0:05 </div><yt-formatted-string class="segment-text">hello</yt-formatted-string></ytd-transcript-segment-renderer>`
    vi.stubGlobal('fetch', vi.fn())
    expect(await fetchTranscriptRaw(ID)).toEqual({ kind: 'dom', rows: [{ time: '0:05', text: 'hello' }] })
  })

  it('uses the caption track when YouTube’s transcript request gives nothing', async () => {
    at(`/watch?v=${ID}`)
    const w = window as unknown as Record<string, unknown>
    w.ytcfg = { get: (k: string) => ({ INNERTUBE_API_KEY: 'k', INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.2026' } }, INNERTUBE_CONTEXT_CLIENT_NAME: 1 })[k] }
    w.ytInitialData = { engagementPanels: [{ getTranscriptEndpoint: { params: 'P' } }] }
    w.ytInitialPlayerResponse = {
      videoDetails: { videoId: ID },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [
        { baseUrl: `https://www.youtube.com/api/timedtext?v=${ID}&lang=en&kind=asr`, languageCode: 'en', kind: 'asr' },
        { baseUrl: `https://www.youtube.com/api/timedtext?v=${ID}&lang=en`, languageCode: 'en' },
      ] } },
    }
    const asked: { url: string; headers?: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      asked.push({ url, headers: init?.headers })
      // YouTube refuses the transcript request (as it does for some videos and clients).
      if (url.includes('get_transcript')) return new Response('{"error":{"code":400}}', { status: 400 })
      if (url.includes('/api/timedtext')) return new Response(JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'written ' }, { utf8: 'by hand' }] }] }))
      return new Response('', { status: 404 })
    }))
    const raw = await fetchTranscriptRaw(ID)
    expect(asked[0]).toMatchObject({ url: expect.stringContaining('/youtubei/v1/get_transcript?key=k'), headers: expect.objectContaining({ 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': '2.2026' }) })
    // The track someone wrote, not the automatic one, in json3.
    expect(asked[1].url).toBe(`https://www.youtube.com/api/timedtext?v=${ID}&lang=en&fmt=json3`)
    expect(segmentsFromRaw(raw)).toEqual([{ start: 1, end: 3, text: 'written by hand' }])
  })

  it('a transcript answer without lines is not taken as the transcript', async () => {
    at(`/watch?v=${ID}`)
    const w = window as unknown as Record<string, unknown>
    w.ytcfg = { get: (k: string) => ({ INNERTUBE_CONTEXT: { client: { clientName: 'WEB' } } })[k] }
    w.ytInitialData = { x: { getTranscriptEndpoint: { params: 'P' } } }
    w.ytInitialPlayerResponse = { videoDetails: { videoId: ID } }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('get_transcript')) return new Response('{"responseContext":{}}')
      return new Response('{}')
    }))
    // Nothing anywhere, and no panel to open: say what to do.
    const raw = await fetchTranscriptRaw(ID)
    expect(raw).toEqual({ kind: 'none', reason: expect.stringContaining('Show transcript') })
  }, 10_000)
})
