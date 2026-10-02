/**
 * Settings > Shared links: every link that lets someone read a copy of a chat, a
 * document or a project overview without logging in, and the place to withdraw them.
 */
import { Link2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { confirmDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { useRevokeAllShares, useShares } from './api'
import { LinkRow } from './LinkRow'

export function SharedLinksPage() {
  const links = useShares()
  const revokeAll = useRevokeAllShares()
  const all = links.data ?? []

  const confirmRevokeAll = async () => {
    const ok = await confirmDialog({
      title: 'Revoke every link?',
      message: `${all.length === 1 ? 'The link stops' : `All ${all.length} links stop`} working at once. This cannot be undone; you can create new links afterwards.`,
      confirmLabel: 'Revoke all',
      danger: true,
    })
    if (ok) revokeAll.mutate()
  }

  return (
    <Card>
      <CardHeader
        title="Shared links"
        description="Anyone with one of these links can read a copy without logging in. A copy is made when the link is created and only changes when you update it. To share something, use Share in the menu of a chat, a document or a project."
        actions={all.length > 0 && (
          <Button size="sm" variant="ghost" className="shrink-0 text-error hover:text-error" loading={revokeAll.isPending} onClick={() => void confirmRevokeAll()}>
            Revoke all
          </Button>
        )}
      />
      <CardBody>
        {(links.error ?? revokeAll.error) && <p className="mb-3 text-[13px] text-error">{errorMessage(links.error ?? revokeAll.error)}</p>}
        {links.isSuccess && all.length === 0 ? (
          <EmptyState icon={<Link2 className="h-5 w-5" />} title="Nothing is shared"
            description="No link gives access to anything. Only you, logged in, can see your workspace." />
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {all.map((link) => (
              <div key={link.id} role="group" aria-label={`Link to ${link.title}`} className="py-4 first:pt-0 last:pb-0">
                <LinkRow link={link} showTarget />
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
