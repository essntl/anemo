/**
 * Things the search box (Ctrl+K) can do, besides finding and opening: the focus timer
 * and the music player. Offered once something matching is typed ("focus", "pause",
 * "next", "music"…).
 */
import { CirclePlay, Keyboard, LayoutGrid, Link2, type LucideIcon, Pause, SkipForward, Timer } from 'lucide-react'
import { promptDialog } from '@/components/ui/dialogs'
import { toast } from '@/components/ui/toast'
import { msg, t } from '@/lib/i18n'
import { timerActions, useTimerStore } from '@/features/focus/timerStore'
import { player } from '@/features/music/player/controller'
import { askPlaylistChoice } from '@/features/music/playlistChoice'
import type { PageId } from '@/features/settings/navigation'
import { hasKeyboard, useShortcutSheet } from '@/features/shortcuts/sheetStore'

export interface PaletteAction {
  label: string
  icon: LucideIcon
  keywords: string
  /** Runs after the box has closed; gets a way to open a page. */
  run: (navigate: (to: string) => void) => void
  /** The page it belongs to: not offered while that page is turned off (Settings > Pages). */
  of?: PageId
  /** Offered only when this says so (default: always). */
  available?: () => boolean
}

/**
 * Runs `fn` once the search box has finished closing. Needed for actions that open a
 * dialog: while the box is still fading out it would take the dialog's Esc for itself.
 */
function afterPaletteCloses(fn: () => void, deadline = performance.now() + 1000) {
  if (!document.querySelector('[data-command-palette]') || performance.now() > deadline) fn()
  else requestAnimationFrame(() => afterPaletteCloses(fn, deadline))
}

export const ACTIONS: PaletteAction[] = [
  { label: msg('Start focus'), icon: Timer, keywords: msg('focus timer pomodoro start session'), of: 'focus', run: () => timerActions.focusOn(useTimerStore.getState().timer.taskId) },
  { label: msg('Pause or resume the timer'), icon: Pause, keywords: msg('focus timer pause resume stop'), of: 'focus', run: () => timerActions.toggle() },
  { label: msg('Play or pause music'), icon: CirclePlay, keywords: msg('music play pause song track'), of: 'music', run: () => player.toggle() },
  { label: msg('Next track'), icon: SkipForward, keywords: msg('music next skip song track'), of: 'music', run: () => player.next() },
  {
    label: msg('Paste a music link…'),
    icon: Link2,
    keywords: msg('music add queue youtube soundcloud radio link url paste'),
    of: 'music',
    run: async () => {
      const link = await promptDialog({ title: t('Add music'), label: t('A YouTube, SoundCloud or audio link'), placeholder: 'https://', confirmLabel: t('Add') })
      if (!link?.trim()) return
      const choice = await askPlaylistChoice(link.trim())
      if (!choice) return
      player.add(link.trim(), { choice }).catch((err: Error) => toast({ message: err.message }))
    },
  },
  { label: msg('Edit home layout'), icon: LayoutGrid, keywords: msg('home widgets layout dashboard edit arrange'), run: (navigate) => navigate('/home?edit=1') },
  {
    label: msg('Keyboard shortcuts'),
    icon: Keyboard,
    keywords: msg('keyboard shortcuts keys hotkeys help cheat sheet'),
    run: () => afterPaletteCloses(() => useShortcutSheet.getState().setOpen(true)),
    available: hasKeyboard,
  },
]

/** Actions whose name or keywords, in English or the current language, contain every word typed (none until something is typed). */
export function matchingActions(query: string, off: readonly PageId[] = []): PaletteAction[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return ACTIONS.filter((a) => (a.available?.() ?? true) && !(a.of && off.includes(a.of)) && words.every((w) => `${a.label} ${a.keywords} ${t(a.label)} ${t(a.keywords)}`.toLowerCase().includes(w)))
}
