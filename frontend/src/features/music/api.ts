import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'
import { toast } from '@/components/ui/toast'
import { islandAlert } from '@/features/island/alerts'
import { artworkSrc } from './player/detect'
import { saveToLibrary } from './player/controller'
import type { Track } from './player/types'

export type Playlist = Schemas['PlaylistOut']
export type LibraryTrack = Schemas['TrackOut']
export const musicKey = ['music'] as const
const playlistsKey = [...musicKey, 'playlists'] as const

export function usePlaylists() {
  return useQuery({
    queryKey: playlistsKey,
    queryFn: async () => unwrap(await api.GET('/api/music/playlists')),
  })
}

function useRefresh() {
  const qc = useQueryClient()
  return () => void qc.invalidateQueries({ queryKey: musicKey })
}

/** Library ids for these tracks, saving any that are not in the library yet. */
async function libraryIds(tracks: Track[]): Promise<string[]> {
  const missing = tracks.filter((t) => !t.trackId)
  const saved = missing.length ? await saveToLibrary(missing) : []
  const ids = new Map(saved.map((t) => [t.id, t.trackId]))
  const out = tracks.map((t) => t.trackId ?? ids.get(t.id) ?? null)
  if (out.some((id) => !id)) throw new Error("Couldn't save the tracks. Check the connection and try again.")
  return out as string[]
}

/** A new playlist, optionally with tracks (from the queue). */
export function useCreatePlaylist() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (v: { name: string; tracks?: Track[] }) =>
      unwrap(await api.POST('/api/music/playlists', { body: { name: v.name, track_ids: await libraryIds(v.tracks ?? []) } })),
    onSuccess: refresh,
  })
}

export function useRenamePlaylist() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (v: { id: string; name: string }) =>
      unwrap(await api.PATCH('/api/music/playlists/{playlist_id}', { params: { path: { playlist_id: v.id } }, body: { name: v.name } })),
    onSuccess: refresh,
  })
}

/** Delete a playlist, with Undo (puts it back with its tracks, in its place). */
export function useDeletePlaylist() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (pl: Playlist) => {
      unwrap(await api.DELETE('/api/music/playlists/{playlist_id}', { params: { path: { playlist_id: pl.id } } }))
      return pl
    },
    onSuccess: (pl) => {
      refresh()
      toast({
        message: `Deleted “${pl.name}”`,
        duration: 10_000,
        action: {
          label: 'Undo',
          onClick: () =>
            void api
              .POST('/api/music/playlists', { body: { name: pl.name, track_ids: pl.tracks.map((t) => t.id), sort_order: pl.sort_order } })
              .then(refresh),
        },
      })
    },
  })
}

/** The playlist's tracks in a new order, or with some removed. */
export function useSetPlaylistTracks() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; trackIds: string[] }) =>
      unwrap(
        await api.PUT('/api/music/playlists/{playlist_id}/tracks', {
          params: { path: { playlist_id: v.id } },
          body: { track_ids: v.trackIds },
        }),
      ),
    // Show the new order at once (dragging should feel instant).
    onMutate: (v) => {
      qc.setQueryData<Playlist[]>(playlistsKey, (old) =>
        old?.map((pl) => {
          if (pl.id !== v.id) return pl
          const byId = new Map(pl.tracks.map((t) => [t.id, t]))
          return { ...pl, tracks: v.trackIds.map((id) => byId.get(id)).filter((t): t is LibraryTrack => !!t) }
        }),
      )
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: musicKey }),
  })
}

/** Add tracks to the end of a playlist (ones already in it are skipped). */
export function useAddToPlaylist() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: async (v: { playlist: Playlist; tracks: Track[] }) => {
      const ids = await libraryIds(v.tracks)
      const already = new Set(v.playlist.tracks.map((t) => t.id))
      const result = unwrap(
        await api.POST('/api/music/playlists/{playlist_id}/tracks', {
          params: { path: { playlist_id: v.playlist.id } },
          body: { track_ids: ids },
        }),
      )
      return { result, added: ids.filter((id) => !already.has(id)).length, v }
    },
    onSuccess: ({ added, v }) => {
      refresh()
      const one = v.tracks.length === 1 ? v.tracks[0] : null
      islandAlert(
        added === 0
          ? { title: 'Already in the playlist', body: v.playlist.name, icon: 'check', tone: 'info', duration: 2000 }
          : {
              title: `Added to ${v.playlist.name}`,
              body: one?.title ?? `${added} tracks`,
              icon: 'plus',
              image: one ? artworkSrc(one.artwork) : null,
              tone: 'success',
              duration: 2200,
            },
      )
    },
  })
}
