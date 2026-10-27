import { ListPlus, Plus } from 'lucide-react'
import type { MenuAction } from '@/components/ui/ActionMenu'
import { promptDialog } from '@/components/ui/dialogs'
import { type Playlist, useAddToPlaylist, useCreatePlaylist, usePlaylists } from './api'
import type { Track } from './player/types'

/** Menu entries shared by queue rows: add to a playlist, or start a new one with the track. */
export function usePlaylistActions() {
  const playlists = usePlaylists()
  const addTo = useAddToPlaylist()
  const create = useCreatePlaylist()
  return (track: Track): MenuAction[] => [
    ...(playlists.data ?? []).map((pl: Playlist) => ({
      label: `Add to ${pl.name}`,
      icon: <ListPlus />,
      onSelect: () => addTo.mutate({ playlist: pl, tracks: [track] }),
    })),
    {
      label: 'New playlist with this track',
      icon: <Plus />,
      onSelect: async () => {
        const name = await promptDialog({ title: 'New playlist', label: 'Name', placeholder: 'e.g. Deep focus', confirmLabel: 'Create' })
        if (name?.trim()) create.mutate({ name: name.trim(), tracks: [track] })
      },
    },
  ]
}

