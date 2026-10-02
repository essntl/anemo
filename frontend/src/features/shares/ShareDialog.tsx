import { useState } from 'react'
import { Link2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog } from '@/components/ui/Dialog'
import { Lingering } from '@/components/ui/Lingering'
import { Select } from '@/components/ui/Select'
import { type ShareTarget, useCreateShare, useShares } from './api'
import { LinkRow } from './LinkRow'
import { EXPIRY_OPTIONS, PROJECT_SECTIONS, type ProjectSection } from './links'
import { useShareDialog } from './shareStore'

/** What a copy holds, said plainly, so there are no surprises about what a visitor sees. */
const INCLUDED = {
  chat: 'The copy has the messages and the names of attached files. Not the files themselves, the model’s reasoning or what an agent did.',
  document: 'The copy has the document’s text. Images stored in your workspace are not shown.',
  project: 'The copy has what you tick above; documents can be read in full. Never the project’s chats, files or instructions. Images stored in your workspace are not shown.',
}

function ShareLinks({ target }: { target: ShareTarget }) {
  const close = useShareDialog((s) => s.close)
  const links = useShares(target)
  const create = useCreateShare()
  const [days, setDays] = useState('7')
  const [sections, setSections] = useState<ProjectSection[]>(['tasks', 'events', 'documents'])
  const isProject = target.kind === 'project'
  const toggle = (section: ProjectSection, on: boolean) =>
    setSections((old) => (on ? [...old, section] : old.filter((s) => s !== section)))
  const submit = () =>
    create.mutate({ target, days: days ? Number(days) : null, sections: isProject ? sections : undefined })

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      title={`Share “${target.title}”`}
      description="Anyone with the link can read a copy as it is now, without logging in. They cannot change anything or see the rest of your workspace."
      className="md:w-[min(92vw,540px)]"
      footer={<Button variant="ghost" onClick={close}>Done</Button>}
    >
      {(links.data ?? []).length > 0 && (
        <div className="mb-5 flex flex-col gap-4 border-b border-border pb-5">
          {links.data!.map((link) => <LinkRow key={link.id} link={link} />)}
        </div>
      )}
      {links.error && <p className="mb-3 text-[13px] text-error">{errorMessage(links.error)}</p>}

      <div className="flex flex-col gap-3">
        {isProject && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-[13px] font-medium">Include</legend>
            {PROJECT_SECTIONS.map((s) => (
              <label key={s.value} className="flex items-center gap-2.5 text-[14px]">
                <Checkbox checked={sections.includes(s.value)} onChange={(e) => toggle(s.value, e.target.checked)} />
                <span>{s.label} <span className="text-[12.5px] text-muted">({s.hint})</span></span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="mb-1.5 block text-[13px] font-medium">The link works for</span>
            <Select aria-label="The link works for" value={days} onValueChange={setDays} options={EXPIRY_OPTIONS} />
          </label>
          <Button variant="primary" className="shrink-0" loading={create.isPending} disabled={isProject && sections.length === 0}
            icon={<Link2 className="h-4 w-4" />} onClick={submit}>
            {(links.data ?? []).length > 0 ? 'Create another link' : 'Create link'}
          </Button>
        </div>
        <p className="text-[12.5px] text-muted">{INCLUDED[target.kind]}</p>
        {create.isError && <p className="text-[13px] text-error">{errorMessage(create.error)}</p>}
      </div>
    </Dialog>
  )
}

/** Mounted once (AppLayout): shows the "Share" dialog when something asks for it. */
export function ShareDialog() {
  const target = useShareDialog((s) => s.target)
  return <Lingering value={target}>{(shown) => <ShareLinks target={shown} />}</Lingering>
}
