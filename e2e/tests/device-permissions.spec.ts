import { expect, test } from '@playwright/test'
import { FakeComputer, type FakeCommand } from './fakeDevice'
import { fakeModels, login, newAgentChatWithLevels, send, signOutAfterEach } from './helpers'

signOutAfterEach()

/*
 * Permission profiles per device (docs/specs/25-device-permission-profiles.md §11 C), with a
 * fake Anemo Desktop 1.10.0 that keeps its synced profile and analyses commands the way the
 * real one does for these four cases:
 *   a delete in a work folder: no question;
 *   a delete in Pictures: asks, with Once / This folder / The next hour;
 *   "This folder": the next delete there asks nothing;
 *   a delete in .ssh: refused.
 */

type Profile = { version: number; work_folders: { path: string }[] }

function analyse(command: string, profile: Profile | null) {
  const path = command.replace(/^Remove-Item\s+/i, '').trim()
  const effects = [{ kind: 'delete', path, recursive: false, work_folder: null, recycle: false }]
  if (/\\\.ssh(\\|$)/i.test(path)) {
    return { verdict: 'deny', effects, unknown: [], rule: `the protected folder ${path.replace(/\\[^\\]+$/, '')}: refused`, network: false, profile_version: profile?.version ?? 0 }
  }
  const holder = (profile?.work_folders ?? []).find((f) => path.toLowerCase().startsWith(f.path.toLowerCase() + '\\'))
  if (holder) {
    return { verdict: 'allow', effects, unknown: [], rule: `delete inside work folder ${holder.path}`, network: false, profile_version: profile!.version }
  }
  const folder = path.replace(/\\[^\\]+$/, '')
  return {
    verdict: 'ask', effects, unknown: [], rule: `deletes ${path}, outside the work folders (read-only there)`, network: false,
    profile_version: profile?.version ?? 0, folder, parent_folder: folder.replace(/\\[^\\]+$/, ''),
  }
}

test('a Scoped computer: work folders pass, Pictures asks until "This folder", .ssh is refused', async ({ page, baseURL }) => {
  await login(page)
  const models = await fakeModels(page.request)
  const name = `E2E Scoped PC ${Date.now().toString(36)}`
  let computer: FakeComputer | undefined
  let agentProfile = ''
  let profile: Profile | null = null
  const shells: FakeCommand[] = []
  try {
    computer = await FakeComputer.connect(page.request, baseURL!, name, 'trusted', { version: '1.10.0', capabilities: ['profiles', 'shell.analyze'] })
    computer.answer = (command) => {
      if (command.action === 'profile.sync') {
        profile = command.profile as Profile
        return { applied: true, version: profile.version, pending: false }
      }
      if (command.action === 'shell.analyze') return analyse(String(command.command), profile)
      if (command.action === 'shell') {
        shells.push(command)
        return { exit_code: 0, stdout: 'removed', stderr: '', truncated: false, duration_ms: 5 }
      }
      throw new Error(`unexpected ${command.action}`)
    }
    computer.offer({ control: true, shell: true })
    const profiles = (await (await page.request.get('/api/devices/profiles')).json()) as { id: string; preset: string | null }[]
    const scoped = profiles.find((p) => p.preset === 'scoped')!
    const set = await page.request.put(`/api/devices/${computer.id}/permissions`, {
      data: { profile_id: scoped.id, work_folders: [{ path: 'C:\\dev', recycle: false, added_from: 'settings' }] },
    })
    expect(set.ok(), await set.text()).toBe(true)
    await expect.poll(() => profile?.work_folders.map((f) => f.path)).toEqual(['C:\\dev'])
    computer.offer({ control: true, shell: true, profile_version: profile!.version })

    agentProfile = await newAgentChatWithLevels(page, models.agent, { 'computer.shell': 'autonomous' })

    // 1. A delete in a work folder: no question.
    await send(page, `on ${name} run: Remove-Item C:\\dev\\old.log`)
    await expect(page.getByText('Done. removed')).toBeVisible({ timeout: 20_000 })
    expect(shells.at(-1)?.auto).toEqual({ rule: 'delete inside work folder C:\\dev' })

    // 2. A delete in Pictures asks, and says why and where.
    await send(page, `on ${name} run: Remove-Item C:\\Users\\e2e\\Pictures\\x.png`)
    const card = page.getByTestId('device-approval').first()
    await expect(card).toContainText('outside the work folders', { timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'The next hour' }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Allow for this run' })).toHaveCount(0)
    // 3. "This folder": it becomes a work folder of that computer, and the command runs.
    await page.getByRole('button', { name: 'This folder' }).first().click()
    await expect(page.getByText('Done. removed')).toHaveCount(2, { timeout: 20_000 })
    expect((shells.at(-1)?.approval as { scope: string }).scope).toBe('folder')
    await expect.poll(() => profile?.work_folders.map((f) => f.path)).toContain('C:\\Users\\e2e\\Pictures')

    // The next delete there asks nothing.
    await send(page, `on ${name} run: Remove-Item C:\\Users\\e2e\\Pictures\\y.png`)
    await expect(page.getByText('Done. removed')).toHaveCount(3, { timeout: 20_000 })
    expect(shells.at(-1)?.auto).toEqual({ rule: 'delete inside work folder C:\\Users\\e2e\\Pictures' })

    // 4. A delete in .ssh is refused, without asking and without reaching the shell.
    const before = shells.length
    await send(page, `on ${name} run: Remove-Item C:\\Users\\e2e\\.ssh\\id_rsa`)
    await expect(page.getByText(/Done\. Not allowed by the user's permission settings/)).toBeVisible({ timeout: 20_000 })
    expect(shells.length).toBe(before)

    // The work folder added from the approval shows in Settings, marked so.
    await page.goto('/settings/devices')
    await page.getByTestId('device-row').filter({ hasText: name }).getByRole('button', { name: 'Permissions' }).click()
    const folders = page.getByTestId('work-folder')
    await expect(folders.filter({ hasText: 'C:\\Users\\e2e\\Pictures' })).toContainText('added from an approval')
  } finally {
    if (agentProfile) await page.request.delete(`/api/profiles/${agentProfile}`)
    await computer?.remove()
  }
})
