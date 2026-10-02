import { create } from 'zustand'
import type { ShareTarget } from './api'

/** What the "Share" dialog is open for (set from a chat's menu, a document or a project). */
interface ShareState {
  target: ShareTarget | null
  ask: (target: ShareTarget) => void
  close: () => void
}

export const useShareDialog = create<ShareState>((set) => ({
  target: null,
  ask: (target) => set({ target }),
  close: () => set({ target: null }),
}))
