/** Shows the dialogs requested with confirmDialog / promptDialog (see dialogs.ts). */
import { useRef, useState, type FormEvent } from 'react'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { type Request, useDialogQueue } from './dialogs'
import { Input } from './Input'
import { Lingering } from './Lingering'

export function DialogHost() {
  const current = useDialogQueue((s) => s.queue[0])
  // key: a fresh component (and input state) for every request.
  return <Lingering value={current}>{(request) => <RequestDialog key={request.id} request={request} />}</Lingering>
}

function RequestDialog({ request }: { request: Request }) {
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
