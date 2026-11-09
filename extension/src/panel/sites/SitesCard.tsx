/** Settings: the sites the panel may read without a click (given with "Always allow"). */
import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { rememberedSites, siteName } from '@/shared/sites'
import { Button } from '../ui/Button'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { usePreferences } from '../state/preferences'
import { useSession } from '../state/useSession'

export function SitesCard() {
  const { connection } = useSession()
  const { prefs } = usePreferences()
  const [sites, setSites] = useState<string[] | null>(null)
  const load = useCallback(() => {
    void chrome.permissions.getAll().then((all) => setSites(rememberedSites(all.origins ?? [], connection.serverUrl, prefs.features.youtubeNotes)))
  }, [connection.serverUrl, prefs.features.youtubeNotes])

  useEffect(() => {
    load()
    chrome.permissions.onAdded.addListener(load)
    chrome.permissions.onRemoved.addListener(load)
    return () => {
      chrome.permissions.onAdded.removeListener(load)
      chrome.permissions.onRemoved.removeListener(load)
    }
  }, [load])

  return (
    <Card>
      <CardHeader
        title="Sites Anemo can read from the panel"
        description="On other sites, click the toolbar icon on the tab (or use the right-click menu) first. After that, “Always allow” adds the site here."
      />
      <CardBody>
        {!sites || sites.length === 0 ? (
          <p className="text-[12.5px] text-muted">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Allowed sites">
            {sites.map((s) => (
              <li key={s} className="flex items-center gap-2 rounded-control border border-border px-3 py-1.5 text-[13px]">
                <span className="flex-1 truncate">{siteName(s)}</span>
                <Button size="icon" variant="ghost" aria-label={`Remove ${siteName(s)}`} onClick={() => void chrome.permissions.remove({ origins: [s] }).then(load)} icon={<X className="h-3.5 w-3.5" />} />
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}
