/**
 * Every keyboard shortcut of the app, in one list. The code that reacts to a key reads
 * its keys from here (useShortcut, or matchesShortcut in a component's own key
 * handler), and the shortcut sheet (press ?) lists the same entries, so the sheet
 * can't fall out of date: changing a key here changes both.
 *
 * Adding a shortcut: add an entry, then react to it with useShortcut(id, …) or
 * matchesShortcut(SHORTCUTS[id], e). guard.test.ts fails for a new keydown
 * listener on window/document that doesn't go through this list.
 */

import { msg } from '@/lib/i18n'

export interface KeyCombo {
  /** KeyboardEvent.key: one character (compared without case) or a name like 'Escape'. */
  key: string
  /** Ctrl, or ⌘ on a Mac (either is accepted on every system). */
  mod?: boolean
  /** true: Shift must be held, false: must not be; left out: either (e.g. ? or +). */
  shift?: boolean
  alt?: boolean
  /** Also reacts to this, but the sheet doesn't show it (= for +, Backspace for Delete). */
  quiet?: boolean
}

export interface Shortcut {
  /** Any one of these. */
  keys: KeyCombo[]
  description: string
  area: AreaId
  /** Words before the keys, e.g. "Hold" for a key you keep pressed. */
  prefix?: string
}

export type AreaId = 'everywhere' | 'search' | 'chat' | 'home' | 'focus' | 'music' | 'files' | 'diagram'

export interface Area {
  id: AreaId
  title: string
  /** The pages this area belongs to: shown first in the sheet there. */
  pages?: (pathname: string) => boolean
}

export const AREAS: Area[] = [
  { id: 'everywhere', title: msg('Everywhere') },
  { id: 'search', title: msg('Search box'), pages: (p) => p === '/search' },
  { id: 'chat', title: msg('Chat'), pages: (p) => p === '/' || p.startsWith('/c/') || p === '/chats' },
  { id: 'home', title: msg('Home'), pages: (p) => p === '/home' },
  { id: 'focus', title: msg('Focus'), pages: (p) => p === '/focus' },
  { id: 'music', title: msg('Music'), pages: (p) => p === '/music' },
  { id: 'files', title: msg('Files'), pages: (p) => p === '/files' },
  { id: 'diagram', title: msg('Diagram or chart in full screen') },
]

const ARROWS: KeyCombo[] = [{ key: 'ArrowUp' }, { key: 'ArrowDown' }, { key: 'ArrowLeft' }, { key: 'ArrowRight' }]

export const SHORTCUTS = {
  'app.search': { area: 'everywhere', keys: [{ key: 'k', mod: true }], description: msg('Search everything, open a page or run an action') },
  'app.sidebar': { area: 'everywhere', keys: [{ key: '\\', mod: true }], description: msg('Fold or unfold the sidebar') },
  'app.shortcuts': { area: 'everywhere', keys: [{ key: '?' }], description: msg('Show these keyboard shortcuts') },
  'app.close': { area: 'everywhere', keys: [{ key: 'Escape' }], description: msg('Close a dialog, a menu or the Island’s controls') },

  'search.move': { area: 'search', keys: [{ key: 'ArrowUp' }, { key: 'ArrowDown' }], description: msg('Move through the results') },
  'search.open': { area: 'search', keys: [{ key: 'Enter' }], description: msg('Open the chosen result or run the action') },

  'chat.send': { area: 'chat', keys: [{ key: 'Enter', shift: false }, { key: 'Enter', shift: false, mod: true, quiet: true }], description: msg('Send the message') },
  'chat.newline': { area: 'chat', keys: [{ key: 'Enter', shift: true }], description: msg('Start a new line') },
  'chat.allow': { area: 'chat', keys: [{ key: 'Enter', mod: true, shift: true }], description: msg('Allow what the agent asks for, once') },
  'chat.deny': { area: 'chat', keys: [{ key: 'Backspace', mod: true, shift: true }], description: msg('Deny what the agent asks for') },
  'chat.skill': { area: 'chat', keys: [{ key: '/' }], description: msg('At the start of a message: pick a skill') },
  'chat.quickDelete': { area: 'chat', keys: [{ key: 'Shift' }], prefix: msg('Hold'), description: msg('Over the chat list in the sidebar: delete chats with one click') },

  'home.edit': { area: 'home', keys: [{ key: 'e' }], description: msg('Edit the layout, or stop editing') },
  'home.stopEditing': { area: 'home', keys: [{ key: 'Escape' }], description: msg('Stop editing the layout') },
  'home.move': { area: 'home', keys: ARROWS.map((k) => ({ ...k, shift: false })), description: msg('While editing: move the focused widget') },
  'home.resize': { area: 'home', keys: ARROWS.map((k) => ({ ...k, shift: true })), description: msg('While editing: make the focused widget wider, narrower, taller or shorter') },
  'home.hide': { area: 'home', keys: [{ key: 'Delete', shift: false }, { key: 'Backspace', shift: false, quiet: true }], description: msg('While editing: hide the focused widget') },

  'focus.toggle': { area: 'focus', keys: [{ key: ' ' }], description: msg('Start or pause the timer') },
  'focus.reset': { area: 'focus', keys: [{ key: 'r' }], description: msg('Reset the timer') },
  'focus.skip': { area: 'focus', keys: [{ key: 's' }], description: msg('Skip to the next phase') },
  'focus.addMinute': { area: 'focus', keys: [{ key: '+' }, { key: '=', quiet: true }], description: msg('Add a minute') },

  'music.toggle': { area: 'music', keys: [{ key: ' ' }], description: msg('Play or pause') },

  'files.save': { area: 'files', keys: [{ key: 's', mod: true }], description: msg('Save the file you are editing') },
  'files.paste': { area: 'files', keys: [{ key: 'v', mod: true }], description: msg('Paste what you cut or copied into the open folder') },
  'files.cancelPaste': { area: 'files', keys: [{ key: 'Escape' }], description: msg('Forget what you cut or copied') },
  'diagram.zoomIn': { area: 'diagram', keys: [{ key: '+' }, { key: '=', quiet: true }], description: msg('Zoom in') },
  'diagram.zoomOut': { area: 'diagram', keys: [{ key: '-' }], description: msg('Zoom out') },
  'diagram.fit': { area: 'diagram', keys: [{ key: '0' }], description: msg('Fit to the window') },
} satisfies Record<string, Shortcut>

export type ShortcutId = keyof typeof SHORTCUTS

export function shortcut(id: ShortcutId): Shortcut {
  return SHORTCUTS[id]
}

/** A DOM or React key event: only these parts are read. */
export type KeyPress = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

export function matchesCombo(combo: KeyCombo, e: KeyPress): boolean {
  if (Boolean(combo.mod) !== (e.ctrlKey || e.metaKey)) return false
  if (Boolean(combo.alt) !== e.altKey) return false
  if (combo.shift !== undefined && combo.shift !== e.shiftKey) return false
  return combo.key.length === 1 ? e.key.toLowerCase() === combo.key.toLowerCase() : e.key === combo.key
}

/** Whether this key press is one of the shortcut's keys. */
export function matchesShortcut(s: Shortcut, e: KeyPress): boolean {
  return s.keys.some((combo) => matchesCombo(combo, e))
}

/** Macs (and iPads/iPhones with a keyboard) show ⌘ and ⌥ instead of Ctrl and Alt. */
export function isApple(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
}

/** The keys to press for one combination, in order, e.g. ['Ctrl', 'K'] or ['⌘', 'K']. */
export function comboLabels(combo: KeyCombo, apple: boolean): string[] {
  const parts: string[] = []
  if (combo.mod) parts.push(apple ? '⌘' : 'Ctrl')
  if (combo.alt) parts.push(apple ? '⌥' : 'Alt')
  if (combo.shift) parts.push(apple ? '⇧' : 'Shift')
  parts.push(KEY_NAMES[combo.key] ?? (combo.key.length === 1 ? combo.key.toUpperCase() : combo.key))
  return parts
}

/** The combinations the sheet shows for a shortcut (without the quiet ones). */
export function shownCombos(s: Shortcut, apple: boolean): string[][] {
  return s.keys.filter((k) => !k.quiet).map((k) => comboLabels(k, apple))
}

/** One line of text for a shortcut's keys, for a tooltip: "Ctrl+K", "⌘K". */
export function shortcutText(id: ShortcutId, apple = isApple()): string {
  const [first] = shownCombos(SHORTCUTS[id], apple)
  return apple ? first.join('') : first.join('+')
}

/** The sheet's sections: the areas of the page you are on first, then Everywhere, then the rest. */
export function sheetSections(pathname: string): { area: Area; shortcuts: { id: ShortcutId; shortcut: Shortcut }[] }[] {
  const entries = Object.entries(SHORTCUTS) as [ShortcutId, Shortcut][]
  const here = AREAS.filter((a) => a.pages?.(pathname))
  const ordered = [...here, ...AREAS.filter((a) => !here.includes(a))]
  return ordered
    .map((area) => ({ area, shortcuts: entries.filter(([, s]) => s.area === area.id).map(([id, s]) => ({ id, shortcut: s })) }))
    .filter((section) => section.shortcuts.length > 0)
}
