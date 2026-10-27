import { useState, type FormEvent } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'
import { detectSource } from '../player/detect'
import type { PlaylistChoice } from '../player/controller'
import { askPlaylistChoice } from '../playlistChoice'

/**
 * The "paste a link" field: YouTube videos and playlists, SoundCloud tracks and sets,
 * and direct audio or radio links. Errors show under the field.
 */
export function PasteLinkForm({
  onAdd,
  placeholder = 'Paste a YouTube video/playlist, SoundCloud or audio URL',
  label = 'Music link',
  size = 'md',
  className,
}: {
  onAdd: (link: string, choice: PlaylistChoice) => Promise<unknown>
  placeholder?: string
  label?: string
  size?: 'sm' | 'md'
  className?: string
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const link = value.trim()
    if (!link || busy) return
    if (!detectSource(link)) {
      setError('That is not a link. Paste a YouTube, SoundCloud or audio link.')
      return
    }
    const choice = await askPlaylistChoice(link)
    if (!choice) return
    setError(null)
    setBusy(true)
    try {
      await onAdd(link, choice)
      setValue('')
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that link.")
    } finally {
      setBusy(false)
    }
  }

  const sm = size === 'sm'
  return (
    <form onSubmit={(e) => void submit(e)} className={className}>
      <div className={cn('flex items-center gap-2 rounded-control border border-border bg-surface-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft',
        sm ? 'py-1 pl-3 pr-1' : 'py-1.5 pl-3.5 pr-1.5')}>
        <Plus className={cn('shrink-0 text-muted', sm ? 'h-4 w-4' : 'h-5 w-5')} />
        <input value={value} onChange={(e) => { setValue(e.target.value); setError(null) }}
          placeholder={placeholder} aria-label={label} inputMode="url" autoComplete="off" spellCheck={false}
          aria-invalid={!!error || undefined} aria-describedby={error ? `${label}-error` : undefined}
          className={cn('min-w-0 flex-1 bg-transparent placeholder:text-subtle focus:outline-none', sm ? 'h-8 text-[13.5px]' : 'h-9 text-[14px]')} />
        <Button type="submit" variant="primary" size="sm" disabled={!value.trim() || busy} aria-label={busy ? 'Adding' : undefined}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add'}
        </Button>
      </div>
      {error && <p id={`${label}-error`} role="alert" className="px-1 pt-1.5 text-[12.5px] text-error">{error}</p>}
    </form>
  )
}
