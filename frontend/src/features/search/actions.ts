/**
 * Things the search box (Ctrl+K) can do, besides finding and opening: the focus timer
 * and the music player. Offered once something matching is typed ("focus", "pause",
 * "next", "music"…).
 */
import { CirclePlay, Keyboard, LayoutGrid, Link2, type LucideIcon, Pause, SkipForward, Timer } from 'lucide-react'
import { promptDialog } from '@/components/ui/dialogs'
import { toast } from '@/components/ui/toast'
import { timerActions, useTimerStore } from '@/features/focus/timerStore'
import { player } from '@/features/music/player/controller'
import { askPlaylistChoice } from '@/features/music/playlistChoice'
import { hasKeyboard, useShortcutSheet } from '@/features/shortcuts/sheetStore'

export interface PaletteAction {
  label: string
  icon: LucideIcon
  keywords: string
  /** Runs after the box has closed; gets a way to open a page. */
  run: (navigate: (to: string) => void) => void
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
  { label: 'Start focus', icon: Timer, keywords: 'focus timer pomodoro start session', run: () => timerActions.focusOn(useTimerStore.getState().timer.taskId) },
  { label: 'Pause or resume the timer', icon: Pause, keywords: 'focus timer pause resume stop', run: () => timerActions.toggle() },
  { label: 'Play or pause music', icon: CirclePlay, keywords: 'music play pause song track', run: () => player.toggle() },
  { label: 'Next track', icon: SkipForward, keywords: 'music next skip song track', run: () => player.next() },
  {
    label: 'Paste a music link…',
    icon: Link2,
    keywords: 'music add queue youtube soundcloud radio link url paste',
    run: async () => {
      const link = await promptDialog({ title: 'Add music', label: 'A YouTube, SoundCloud or audio link', placeholder: 'https://', confirmLabel: 'Add' })
      if (!link?.trim()) return
      const choice = await askPlaylistChoice(link.trim())
      if (!choice) return
      player.add(link.trim(), { choice }).catch((err: Error) => toast({ message: err.message }))
    },
  },
  { label: 'Edit home layout', icon: LayoutGrid, keywords: 'home widgets layout dashboard edit arrange', run: (navigate) => navigate('/home?edit=1') },
  {
    label: 'Keyboard shortcuts',
    icon: Keyboard,
    keywords: 'keyboard shortcuts keys hotkeys help cheat sheet',
    run: () => afterPaletteCloses(() => useShortcutSheet.getState().setOpen(true)),
    available: hasKeyboard,
  },
]

/** Actions whose name or keywords contain every word typed (none until something is typed). */
export function matchingActions(query: string): PaletteAction[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return ACTIONS.filter((a) => (a.available?.() ?? true) && words.every((w) => `${a.label} ${a.keywords}`.toLowerCase().includes(w)))
}
