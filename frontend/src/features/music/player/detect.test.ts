import { describe, expect, it } from 'vitest'
import { audioTitle, detectSource } from './detect'

describe('detectSource', () => {
  it('recognises YouTube videos in all their forms', () => {
    for (const link of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'youtube.com/watch?v=dQw4w9WgXcQ&t=42',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    ]) {
      expect(detectSource(link), link).toMatchObject({ kind: 'youtube', videoId: 'dQw4w9WgXcQ' })
    }
  })

  it('tells playlists from videos in a playlist, and ignores mixes', () => {
    expect(detectSource('https://www.youtube.com/playlist?list=PL123')).toMatchObject({ kind: 'youtube-playlist', listId: 'PL123' })
    expect(detectSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123')).toMatchObject({
      kind: 'youtube', videoId: 'dQw4w9WgXcQ', listId: 'PL123',
    })
    const mix = detectSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ')
    expect(mix).toMatchObject({ kind: 'youtube', videoId: 'dQw4w9WgXcQ' })
    expect(mix).not.toHaveProperty('listId')
  })

  it('recognises SoundCloud and drops tracking parameters', () => {
    expect(detectSource('https://soundcloud.com/artist/track?utm_source=x')).toEqual({
      kind: 'soundcloud', url: 'https://soundcloud.com/artist/track',
    })
    expect(detectSource('https://soundcloud.com/')).toBeNull()
  })

  it('treats any other web address as audio or a stream', () => {
    expect(detectSource('https://radio.example/live.mp3')).toEqual({ kind: 'audio', url: 'https://radio.example/live.mp3' })
    expect(detectSource('stream.example.org:8000/radio')).toMatchObject({ kind: 'audio' })
  })

  it('refuses things that are not links', () => {
    for (const input of ['', '   ', 'hello world', 'notaurl', 'javascript:alert(1)', 'ftp://x.example/a.mp3', 'https://youtube.com/watch?v=short']) {
      expect(detectSource(input), input).toBeNull()
    }
  })
})

describe('audioTitle', () => {
  it('uses the file name, or the site', () => {
    expect(audioTitle('https://cdn.example/music/My%20Song.mp3')).toEqual({ title: 'My Song', artist: 'cdn.example' })
    expect(audioTitle('https://radio.example/stream')).toEqual({ title: 'radio.example', artist: 'radio.example' })
  })
})
