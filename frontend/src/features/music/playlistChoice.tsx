import { ListMusic, Video } from 'lucide-react'
import { chooseDialog } from '@/components/ui/dialogs'
import { t } from '@/lib/i18n'
import { detectSource } from './player/detect'
import type { PlaylistChoice } from './player/controller'

/**
 * For a link to a video inside a YouTube playlist: add all of the playlist or just
 * the video? Null when the question was dismissed. Other links need no question.
 */
export async function askPlaylistChoice(link: string): Promise<PlaylistChoice | null> {
  const d = detectSource(link)
  if (d?.kind !== 'youtube' || !d.listId) return 'all'
  const answer = await chooseDialog({
    title: t('This video is part of a playlist'),
    message: t('Add the whole playlist, or only this video?'),
    options: [
      { value: 'all', label: t('The whole playlist'), icon: <ListMusic className="h-4 w-4" /> },
      { value: 'video', label: t('Only this video'), icon: <Video className="h-4 w-4" /> },
    ],
  })
  return answer as PlaylistChoice | null
}

