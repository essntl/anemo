/**
 * YouTube notes (feature 7): timestamped notes for the video in the active tab, kept in one
 * Anemo document per video (documents/YouTube/). The time is taken when you start typing
 * (never during an ad); the video pauses while you write and plays on when you're done.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, ExternalLink, MessageSquareText, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { unwrap } from '@/shared/api'
import { requestFeature } from '@/shared/permissions'
import { storage } from '@/shared/storage'
import { formatTimestamp, frameMarkdown, parseVideoUrl, timestampLink, transcriptAround, type Note, type VideoRef } from '@/shared/youtube'
import { Markdown } from '../chat/Markdown'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { Textarea } from '../ui/Input'
import { cn } from '../lib/cn'
import { usePreferences } from '../state/preferences'
import { useSession } from '../state/useSession'
import { useStored } from '../state/useStored'
import { activeTab } from '../chat/currentTab'
import { changeNotes, findNotesDocument, loadNotes, uploadFrame, type Video } from './api'
import { player } from './player'

const EXPLAIN_WINDOW_S = 60

/** The YouTube tab in front, and the video in it; follows tab switches and YouTube's own
 *  page changes (it moves between videos without loading a new page). */
function useYouTubeTab(): { tabId: number | null; ref: VideoRef | null } {
  const [state, setState] = useState<{ tabId: number | null; ref: VideoRef | null }>({ tabId: null, ref: null })
  useEffect(() => {
    const update = () =>
      void activeTab().then((t) => setState({ tabId: t?.id ?? null, ref: parseVideoUrl(t?.url) }))
    update()
    const onUpdated = (_id: number, change: { url?: string; status?: string }) => {
      if (change.url || change.status === 'complete') update()
    }
    chrome.tabs.onActivated.addListener(update)
    chrome.tabs.onUpdated.addListener(onUpdated)
    return () => {
      chrome.tabs.onActivated.removeListener(update)
      chrome.tabs.onUpdated.removeListener(onUpdated)
    }
  }, [])
  return state
}

function Composer({ tabId, onSave, onCancel, initial }: { tabId: number; initial?: Note; onSave: (note: Note, frame: boolean) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState(initial?.text ?? '')
  const [seconds, setSeconds] = useState<number | null>(initial?.seconds ?? null)
  const [ad, setAd] = useState(false)
  const [frame, setFrame] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])

  // The moment you start typing (not when the note is saved). Never during an ad.
  const takeTime = useCallback(async () => {
    if (seconds !== null) return
    const s = await player.state(tabId)
    if (!s?.ok) return
    if (s.ad) {
      setAd(true)
      return
    }
    setAd(false)
    setSeconds(s.currentTime)
  }, [seconds, tabId])

  // While an ad plays, check again every second.
  useEffect(() => {
    if (!ad) return
    const timer = window.setInterval(() => void takeTime(), 1000)
    return () => window.clearInterval(timer)
  }, [ad, takeTime])

  const save = async () => {
    if (!text.trim() || seconds === null) return
    setSaving(true)
    setError(null)
    try {
      await onSave({ seconds, text: text.trim() }, frame)
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-card border border-border bg-card p-3 shadow-soft" data-testid="note-composer">
      <div className="text-[12px] text-muted">
        {seconds !== null ? <>At <span className="font-mono font-medium text-text">{formatTimestamp(seconds)}</span></> : ad ? 'An ad is playing: the time is taken when the video is back.' : 'The time is taken when you start typing.'}
      </div>
      <Textarea
        ref={ref}
        rows={3}
        aria-label="Note"
        value={text}
        placeholder="Your note (Markdown)"
        onChange={(e) => {
          setText(e.target.value)
          void takeTime()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
          if (e.key === 'Escape') onCancel()
        }}
      />
      {!initial && (
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={frame} onChange={(e) => setFrame(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
          <Camera className="h-3.5 w-3.5 text-muted" /> Attach the current frame
        </label>
      )}
      {error && <p className="text-[12px] text-error">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" loading={saving} disabled={!text.trim() || seconds === null} onClick={() => void save()}>Save note</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

export function NotesView({ onOpenChat }: { onOpenChat: (conversationId: string) => void }) {
  const { api, connection } = useSession()
  const qc = useQueryClient()
  const { prefs, update } = usePreferences()
  const { tabId, ref } = useYouTubeTab()
  const intent = useStored('session', 'notesIntent').value
  const [writing, setWriting] = useState<{ wasPlaying: boolean } | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [explaining, setExplaining] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const enabled = prefs.features.youtubeNotes
  const videoId = ref?.kind === 'video' ? ref.id : null

  const meta = useQuery({
    queryKey: ['yt-meta', tabId, videoId],
    enabled: enabled && tabId !== null && videoId !== null,
    refetchInterval: (q) => (q.state.data?.title ? false : 1000), // YouTube fills the title in a moment
    queryFn: async () => player.state(tabId!),
  })
  const video: Video | null = videoId ? { id: videoId, title: meta.data?.title ?? '', channel: meta.data?.channel ?? '' } : null
  const notes = useQuery({
    queryKey: ['yt-notes', videoId],
    enabled: enabled && video !== null && Boolean(video.title),
    queryFn: async () => {
      const documentId = await findNotesDocument(api, video!)
      return { documentId, notes: documentId ? await loadNotes(api, documentId) : [] }
    },
  })

  const start = useCallback(async () => {
    if (tabId === null) return
    setProblem(null)
    // Pause while you write (and play on afterwards if it was playing).
    const wasPlaying = (await player.play(tabId, false)) ?? false
    setWriting({ wasPlaying })
  }, [tabId])

  // The "add a YouTube note" shortcut.
  useEffect(() => {
    if (!intent || !enabled || tabId === null || videoId === null) return
    void storage.set('session', 'notesIntent', null).then(() => start())
  }, [intent, enabled, tabId, videoId, start])

  const finish = async () => {
    if (tabId !== null && writing?.wasPlaying) await player.play(tabId, true)
    setWriting(null)
  }

  const saveNew = async (note: Note, withFrame: boolean) => {
    let text = note.text
    if (withFrame && tabId !== null) {
      const data = await player.frame(tabId)
      if (data) text = `${text}\n\n${frameMarkdown(await uploadFrame(api, data, video!.id, note.seconds), note.seconds)}`
      else setProblem('The frame couldn’t be captured (this video doesn’t allow it); the note was saved without it.')
    }
    const out = await changeNotes(api, video!, notes.data?.documentId ?? null, (list) => [...list, { ...note, text }])
    qc.setQueryData(['yt-notes', videoId], out)
    await finish()
  }

  const saveEdit = async (index: number, note: Note) => {
    const out = await changeNotes(api, video!, notes.data?.documentId ?? null, (list) => list.map((n, i) => (i === index ? note : n)))
    qc.setQueryData(['yt-notes', videoId], out)
    setEditing(null)
  }

  const remove = async (index: number) => {
    if (!window.confirm('Delete this note?')) return
    const out = await changeNotes(api, video!, notes.data?.documentId ?? null, (list) => list.filter((_, i) => i !== index))
    qc.setQueryData(['yt-notes', videoId], out)
  }

  const explainMoment = async () => {
    if (tabId === null || !video) return
    setExplaining(true)
    setProblem(null)
    try {
      const state = await player.state(tabId)
      const at = state?.currentTime ?? 0
      const { segments, reason } = await player.transcript(tabId, video.id)
      if (!segments.length) {
        setProblem(reason ?? 'This video has no transcript.')
        return
      }
      const excerpt = transcriptAround(segments, at, EXPLAIN_WINDOW_S)
      const conv = unwrap(await api.POST('/api/conversations', { body: { temporary: false } }))
      unwrap(
        await api.POST('/api/conversations/{conversation_id}/turns', {
          params: { path: { conversation_id: conv.id } },
          body: {
            text: `Explain what is said around ${formatTimestamp(at)} in this video, in the context of what comes before and after.`,
            mode: 'chat',
            attachment_ids: [],
            reference_ids: [],
            page: {
              url: timestampLink(video.id, at),
              title: video.title,
              source: 'youtube',
              content: `Video: ${video.title}\nChannel: ${video.channel}\nMoment: ${formatTimestamp(at)}\n\nTranscript from ${formatTimestamp(Math.max(0, at - EXPLAIN_WINDOW_S))} to ${formatTimestamp(at + EXPLAIN_WINDOW_S)}:\n${excerpt}`,
              truncated: false,
            },
          },
        }),
      )
      onOpenChat(conv.id)
    } catch (err) {
      setProblem((err as Error).message)
    } finally {
      setExplaining(false)
    }
  }

  if (!enabled) {
    return (
      <div className="flex flex-col gap-3 p-3">
        <Notice title="YouTube notes are off" actions={<Button size="sm" variant="primary" onClick={() => void requestFeature('youtubeNotes').then(async (ok) => { if (ok) await update((p) => ({ ...p, features: { ...p.features, youtubeNotes: true } })) })}>Switch on</Button>}>
          Timestamped notes for YouTube videos, kept in Anemo. Chrome asks once for access to youtube.com.
        </Notice>
      </div>
    )
  }
  if (!ref) return <div className="p-6 text-center text-[13px] text-muted">Open a YouTube video to take notes.</div>
  if (ref.kind === 'short') return <div className="p-6 text-center text-[13px] text-muted">YouTube Shorts aren’t supported. Open a regular video.</div>

  const list = notes.data?.notes ?? []
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-start gap-2">
        <Play className="mt-0.5 h-5 w-5 shrink-0 fill-current text-error" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[13.5px] font-semibold" data-testid="video-title">{video?.title || 'Loading…'}</div>
          {video?.channel && <div className="truncate text-[12px] text-muted">{video.channel}</div>}
        </div>
        {notes.data?.documentId && (
          <a className="inline-flex h-8 w-8 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-text" href={`${connection.serverUrl}/documents/${notes.data.documentId}`} target="_blank" rel="noopener noreferrer" title="Open the notes in Anemo" aria-label="Open the notes in Anemo">
            <ExternalLink className="h-4 w-4" />
          </a>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} disabled={writing !== null || !video?.title} onClick={() => void start()}>Add note</Button>
        <Button size="sm" icon={<MessageSquareText className="h-3.5 w-3.5" />} loading={explaining} onClick={() => void explainMoment()}>Explain this moment</Button>
      </div>
      {problem && <Notice tone="warning" title="Note">{problem}</Notice>}
      {writing && tabId !== null && <Composer tabId={tabId} onSave={saveNew} onCancel={() => void finish()} />}
      {notes.isError && <Notice tone="error" title="The notes couldn’t be loaded">{(notes.error as Error).message}</Notice>}
      {list.length === 0 && !writing && notes.isSuccess && <p className="text-center text-[12.5px] text-muted">No notes yet for this video.</p>}
      <ol className="flex flex-col gap-2" aria-label="Notes">
        {list.map((n, i) =>
          editing === i && tabId !== null ? (
            <li key={`${n.seconds}-${i}`}>
              <Composer tabId={tabId} initial={n} onSave={(note) => saveEdit(i, note)} onCancel={() => setEditing(null)} />
            </li>
          ) : (
            <li key={`${n.seconds}-${i}`} className="group flex gap-2 rounded-control border border-border bg-card px-2.5 py-2">
              <button type="button" className={cn('h-6 shrink-0 rounded-md bg-accent-soft px-1.5 font-mono text-[12px] font-medium text-accent hover:bg-accent hover:text-accent-contrast')} title="Jump to this moment" onClick={() => tabId !== null && void player.seek(tabId, n.seconds)}>
                {formatTimestamp(n.seconds)}
              </button>
              <div className="min-w-0 flex-1"><Markdown text={n.text} serverUrl={connection.serverUrl} /></div>
              <div className="flex shrink-0 flex-col gap-0.5 opacity-60 group-hover:opacity-100">
                <button type="button" aria-label="Edit note" className="rounded p-1 hover:bg-surface-hover" onClick={() => setEditing(i)}><Pencil className="h-3.5 w-3.5" /></button>
                <button type="button" aria-label="Delete note" className="rounded p-1 hover:bg-surface-hover" onClick={() => void remove(i)}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </li>
          ),
        )}
      </ol>
    </div>
  )
}
