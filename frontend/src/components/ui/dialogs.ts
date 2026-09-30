/**
 * In-app replacements for window.confirm / window.prompt, styled like the rest of
 * the app. Call them from anywhere and await the answer:
 *
 *   if (await confirmDialog({ title: 'Delete this chat?', confirmLabel: 'Delete', danger: true })) ...
 *   const name = await promptDialog({ title: 'New folder', label: 'Folder name' })  // null = cancelled
 *
 * <DialogHost /> (DialogHost.tsx, mounted once in AppLayout) shows them one at a time.
 */
import type { ReactNode } from 'react'
import { create } from 'zustand'

export interface ConfirmOptions {
  title: string
  message?: ReactNode
  confirmLabel?: string
  danger?: boolean
}

export interface PromptOptions {
  title: string
  message?: ReactNode
  label?: string
  initial?: string
  placeholder?: string
  confirmLabel?: string
  /** Pre-select only the name part of "notes.md", like a file manager does. */
  selectName?: boolean
}

export type Request = { id: number } & (
  | ({ kind: 'confirm'; resolve: (ok: boolean) => void } & ConfirmOptions)
  | ({ kind: 'prompt'; resolve: (value: string | null) => void } & PromptOptions)
)

export const useDialogQueue = create<{ queue: Request[] }>(() => ({ queue: [] }))
let nextId = 1

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) =>
    useDialogQueue.setState((s) => ({ queue: [...s.queue, { id: nextId++, kind: 'confirm', resolve, ...options }] })),
  )
}

export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) =>
    useDialogQueue.setState((s) => ({ queue: [...s.queue, { id: nextId++, kind: 'prompt', resolve, ...options }] })),
  )
}
