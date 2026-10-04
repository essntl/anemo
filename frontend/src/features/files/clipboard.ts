import { create } from 'zustand'
import type { Entry } from './api'

/**
 * Cut or copied in the file manager, waiting to be pasted into another folder.
 * Lives for the tab (not saved): like a file manager's clipboard.
 */
interface Clipboard {
  item: Pick<Entry, 'path' | 'name' | 'is_dir'> | null
  mode: 'cut' | 'copy'
  put: (item: Pick<Entry, 'path' | 'name' | 'is_dir'>, mode: 'cut' | 'copy') => void
  clear: () => void
}

export const useClipboard = create<Clipboard>((set) => ({
  item: null,
  mode: 'copy',
  put: (item, mode) => set({ item, mode }),
  clear: () => set({ item: null }),
}))

/** Why it can't be pasted into `folder` (null: it can). */
export function cannotPaste(item: { path: string; is_dir: boolean }, mode: 'cut' | 'copy', folder: string, parent: string): string | null {
  if (item.is_dir && (folder === item.path || folder.startsWith(`${item.path}/`))) return 'A folder can’t go inside itself'
  if (mode === 'cut' && parent === folder) return 'It is already here'
  return null
}
