import { create } from 'zustand'

/**
 * Whether the Dynamic Island is on screen. The phone top bar hides the Anemo name
 * while it is (the Island takes its place in the middle).
 */
export const useIslandVisible = create<{ visible: boolean }>(() => ({ visible: false }))
