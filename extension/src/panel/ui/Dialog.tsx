/** Small dialogs for the panel (confirm, ask for a name), on Radix Dialog. */
import { useState, type ReactNode } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { Button } from './Button'
import { Input } from './Input'

function Shell({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode }) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fade fixed inset-0 z-50 bg-black/40" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className="pop fixed left-1/2 top-[22%] z-50 w-[min(22rem,calc(100vw-24px))] -translate-x-1/2 rounded-card border border-border bg-card p-4 shadow-float focus:outline-none"
        >
          <RadixDialog.Title className="mb-2 text-[14px] font-semibold">{title}</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export function ConfirmDialog({ open, onOpenChange, title, body, confirmLabel, danger, onConfirm }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; body?: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void }) {
  return (
    <Shell open={open} onOpenChange={onOpenChange} title={title}>
      {body && <div className="mb-4 text-[13px] text-muted">{body}</div>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant={danger ? 'danger' : 'primary'}
          onClick={() => {
            onOpenChange(false)
            onConfirm()
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Shell>
  )
}

export function PromptDialog({ open, onOpenChange, title, label, initial, confirmLabel, onConfirm }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; label: string; initial: string; confirmLabel: string; onConfirm: (value: string) => void }) {
  return (
    <Shell open={open} onOpenChange={onOpenChange} title={title}>
      {/* Keyed by the start value: opening it again starts from that value. */}
      {open && <PromptBody key={initial} label={label} initial={initial} confirmLabel={confirmLabel} onCancel={() => onOpenChange(false)} onConfirm={(v) => { onOpenChange(false); onConfirm(v) }} />}
    </Shell>
  )
}

function PromptBody({ label, initial, confirmLabel, onCancel, onConfirm }: { label: string; initial: string; confirmLabel: string; onCancel: () => void; onConfirm: (value: string) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim()) onConfirm(value.trim())
      }}
    >
      <Input aria-label={label} value={value} autoFocus maxLength={200} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={!value.trim()}>
          {confirmLabel}
        </Button>
      </div>
    </form>
  )
}
