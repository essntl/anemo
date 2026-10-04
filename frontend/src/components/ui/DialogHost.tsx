/** Shows the dialogs requested with confirmDialog / promptDialog / chooseDialog (see dialogs.ts). */
import { useRef, useState, type FormEvent } from 'react'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { type ChooseOptions, type Request, useDialogQueue } from './dialogs'
import { Input } from './Input'
import { Lingering } from './Lingering'

export function DialogHost() {
  const current = useDialogQueue((s) => s.queue[0])
  // key: a fresh component (and input state) for every request.
  return <Lingering value={current}>{(request) => <RequestDialog key={request.id} request={request} />}</Lingering>
}

function RequestDialog({ request }: { request: Request }) {
  if (request.kind === 'choose') return <ChooseDialog request={request} />
  return <AskDialog request={request} />
}

/** A list of choices: picking one answers at once. */
function ChooseDialog({ request }: { request: ChooseOptions & { resolve: (value: string | null) => void } }) {
  const finish = (value: string | null) => {
    useDialogQueue.setState((s) => ({ queue: s.queue.slice(1) }))
    request.resolve(value)
  }
  return (
    <Dialog open onOpenChange={(open) => !open && finish(null)} title={request.title} description={request.message}>
      {request.options.length === 0 ? (
        <p className="text-[13px] text-muted">{request.empty ?? 'Nothing to choose from.'}</p>
      ) : (
        <ul className="-mx-2 flex max-h-[50dvh] flex-col gap-0.5 overflow-y-auto" role="listbox" aria-label={request.title}>
          {request.options.map((o) => (
            <li key={o.value}>
              <button type="button" role="option" aria-selected={false} disabled={o.disabled} onClick={() => finish(o.value)}
                className="flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left hover:bg-surface-hover disabled:opacity-50 disabled:hover:bg-transparent">
                {o.icon && <span className="shrink-0 text-muted [&>svg]:h-4 [&>svg]:w-4">{o.icon}</span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px]">{o.label}</span>
                  {o.hint && <span className="block truncate text-[12px] text-muted">{o.hint}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-end">
        <Button variant="ghost" onClick={() => finish(null)}>Cancel</Button>
      </div>
    </Dialog>
  )
}

function AskDialog({ request }: { request: Exclude<Request, { kind: 'choose' }> }) {
  const [value, setValue] = useState(request.kind === 'prompt' ? (request.initial ?? '') : '')
  const inputRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  const finish = (answer: boolean) => {
    useDialogQueue.setState((s) => ({ queue: s.queue.slice(1) }))
    if (request.kind === 'confirm') request.resolve(answer)
    else if (!answer) request.resolve(null)
    else request.resolve(value.trim() || (request.allowEmpty ? '' : null))
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (request.kind === 'prompt' && !value.trim() && !request.allowEmpty) return
    finish(true)
  }

  const focusFirst = () => {
    const input = inputRef.current
    if (!input) {
      formRef.current?.querySelector<HTMLButtonElement>('button[type=submit]')?.focus()
      return
    }
    input.focus()
    const dot = request.kind === 'prompt' && request.selectName ? input.value.lastIndexOf('.') : -1
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
  }

  const confirmLabel = request.confirmLabel ?? (request.kind === 'confirm' ? 'OK' : 'Save')
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && finish(false)}
      title={request.title}
      description={request.message}
      onOpenAutoFocus={(e) => {
        e.preventDefault()
        focusFirst()
      }}
    >
      <form ref={formRef} onSubmit={submit} className="flex flex-col gap-5">
        {request.kind === 'prompt' && (
          <label className="flex flex-col gap-1.5">
            {request.label && <span className="text-[13px] font-medium">{request.label}</span>}
            <Input ref={inputRef} value={value} placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)} />
          </label>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => finish(false)}>Cancel</Button>
          <Button type="submit" variant={request.kind === 'confirm' && request.danger ? 'danger' : 'primary'}
            disabled={request.kind === 'prompt' && !value.trim() && !request.allowEmpty}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
