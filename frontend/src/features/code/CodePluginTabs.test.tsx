import { act, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useParams } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginCodeTab } from '@/features/plugins/slotData'
import type { ContributionUi } from '@/features/plugins/types'
import { contributionsOut, mockApi, renderRoutes, renderWithProviders, stubMatchMedia } from '@/test/pluginFixtures'
import { codeJobKey } from './api'
import { noticeCodeJob } from './codeJobNotices'
import { CodePluginPanel, CodeTabs } from './CodePluginTabs'
import { GIT_TAB, JOB_TAB, useCodeTab } from './codeTab'
import { codeJob } from './testJobs'

/* Plugins' tabs on the Code page (plugin contract §3, `code.panel`): the tab row, the frame
 * with the job's computer and project, context.changed when another job opens, code.job. */

const graphUi: ContributionUi = {
  plugin: 'artem.git-graph', plugin_name: 'Git graph plugin', icon_url: null, version: '1.0.0', permissions: ['code:read'],
  id: 'graph', slot: 'code.panel', title: 'Git graph', icon: 'git-branch', objects: [], fence: null, height: null, entry: 'ui/graph.html',
}
const TAB = 'plugin:artem.git-graph/graph'
const tabs: PluginCodeTab[] = [{ id: TAB, label: 'Git graph', icon: 'git-branch', iconUrl: null }]
const bundle = { entry: 'ui/graph.html', html: '<p>Graph</p>', scripts: [], styles: [], hash: 'h' }

const first = codeJob({ id: 'job-a', project: 'anemo' })
const second = codeJob({ id: 'job-b', project: 'notes' })

/** Starts the frame as its bootstrap would; returns the port the page talks to it on, with what it received. */
async function startFrame() {
  const frame = (await screen.findByTitle('Git graph')) as HTMLIFrameElement
  const win = frame.contentWindow as Window
  const postMessage = vi.spyOn(win, 'postMessage').mockImplementation(() => {})
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { anemo: 1, type: 'hello' }, source: win }))
  })
  await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1))
  const [init, , transfer] = postMessage.mock.calls[0] as unknown as [Record<string, unknown>, string, MessagePort[]]
  const received: { event: string; data: unknown }[] = []
  transfer[0].onmessage = (e: MessageEvent) => received.push(e.data as { event: string; data: unknown })
  return { frame, init, received, port: transfer[0] }
}

describe('plugin tabs on the Code page', () => {
  beforeEach(() => {
    stubMatchMedia()
    localStorage.clear()
    mockApi({
      'GET /api/plugins/contributions': () => contributionsOut({ ui: [graphUi] }),
      'GET /api/plugins/artem.git-graph/versions/1.0.0/ui/graph': () => bundle,
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows the job and Git first and the plugin tabs after them, with their titles', async () => {
    const onTab = vi.fn()
    renderWithProviders(<CodeTabs tabs={tabs} tab={JOB_TAB} onTab={onTab} backTo="/code" />)

    const tablist = screen.getByRole('tablist')
    // Git is Anemo's own tab: always between the job and the plugins.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Job', 'Git', 'Git graph'])
    expect(screen.getByRole('tab', { name: 'Job' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(screen.getByRole('tab', { name: 'Git graph' }))
    expect(onTab).toHaveBeenCalledWith(TAB)
    expect(tablist).toBeInTheDocument()
  })

  it('remembers the tab, and shows the job when that tab is gone', () => {
    const { result, rerender } = renderHook(({ list }) => useCodeTab(list), { initialProps: { list: tabs } })
    expect(result.current[0]).toBe(JOB_TAB)
    act(() => result.current[1](TAB))
    expect(result.current[0]).toBe(TAB)
    expect(localStorage.getItem('anemo.code.tab')).toBe(TAB)
    rerender({ list: [] }) // the plugin was turned off
    expect(result.current[0]).toBe(JOB_TAB)
  })

  it('has the Job and Git tabs with no plugin panels at all, and remembers Git', async () => {
    const onTab = vi.fn()
    renderWithProviders(<CodeTabs tabs={[]} tab={JOB_TAB} onTab={onTab} backTo="/code" />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Job', 'Git'])
    await userEvent.click(screen.getByRole('tab', { name: 'Git' }))
    expect(onTab).toHaveBeenCalledWith(GIT_TAB)

    const { result } = renderHook(() => useCodeTab([]))
    act(() => result.current[1](GIT_TAB))
    expect(result.current[0]).toBe(GIT_TAB) // not a plugin's: it stays without any
    expect(localStorage.getItem('anemo.code.tab')).toBe(GIT_TAB)
  })

  it('gives the frame the job’s computer and project, and keeps it when another job opens', async () => {
    const view = renderRoutes([{ path: '/code/:jobId', element: <Panel /> }], '/code/job-a', (client) => {
      client.setQueryData(codeJobKey('job-a'), { job: first, thread: [first] })
      client.setQueryData(codeJobKey('job-b'), { job: second, thread: [second] })
    })

    const { frame, init, received, port } = await startFrame()
    expect(init).toMatchObject({ slot: 'code.panel', ui: 'graph', context: { code: { device: 'Desk PC', project: 'anemo', jobId: 'job-a' } } })

    await act(() => view.router.navigate('/code/job-b'))
    await waitFor(() => expect(received.map((m) => m.event)).toContain('context.changed'))
    expect(screen.getByTitle('Git graph')).toBe(frame) // the same frame: not loaded again
    expect(received.find((m) => m.event === 'context.changed')?.data).toEqual({ code: { device: 'Desk PC', project: 'notes', jobId: 'job-b' } })
    port.close()
  })

  it('sends code.job for the jobs of the open project only', async () => {
    renderRoutes([{ path: '/code/:jobId', element: <Panel /> }], '/code/job-a', (client) => {
      client.setQueryData(codeJobKey('job-a'), { job: first, thread: [first] })
    })
    const { received, port } = await startFrame()

    act(() => {
      noticeCodeJob({ job_id: 'job-x', device_id: 'dev-1', project: 'notes', state: 'running' })
      noticeCodeJob({ job_id: 'job-y', device_id: 'dev-1', project: 'anemo', state: 'running' })
      noticeCodeJob({ job_id: 'job-y', device_id: 'dev-1', project: 'anemo', state: 'done' })
    })

    await waitFor(() => expect(received.filter((m) => m.event === 'code.job')).toHaveLength(2))
    expect(received.filter((m) => m.event === 'code.job').map((m) => m.data)).toEqual([
      { device: 'Desk PC', project: 'anemo', jobId: 'job-y', state: 'running' },
      { device: 'Desk PC', project: 'anemo', jobId: 'job-y', state: 'done' },
    ])
    port.close()
  })
})

/** The tab of the job in the address, as the Code page shows it. */
function Panel() {
  const { jobId = '' } = useParams()
  return <CodePluginPanel tabId={TAB} jobId={jobId} />
}
