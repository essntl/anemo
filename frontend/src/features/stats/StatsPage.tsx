/**
 * Stats: focus, tasks, projects and (briefly) agents over a range of days. The server
 * does the counting, by day in the time zone of Settings → General; this page only
 * draws. Follows the project switcher.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Bot, ChartColumn, Clock, FolderKanban, Grid3x3, SquareCheckBig, Target } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { useCurrentProject } from '@/app/projectStore'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { Segmented } from '@/components/ui/Segmented'
import { useToday } from '@/hooks/useNow'
import { formatMinutes } from '@/features/focus/api'
import { dayOf } from '@/features/tasks/dates'
import { useStats } from './api'
import { BarChart } from './BarChart'
import { Heatmap } from './Heatmap'
import { HBars, Section, SplitBar, StatTile } from './parts'
import { type RangeKind, rangeFor, toBars } from './ranges'

const count = (v: number) => String(Math.round(v))
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`

export function StatsPage() {
  const today = dayOf(new Date(useToday()))
  const project = useCurrentProject()
  const [kind, setKind] = useState<RangeKind>('week')
  const [custom, setCustom] = useState(() => rangeFor('month', today))
  const range = kind === 'custom' ? custom : rangeFor(kind, today)
  const stats = useStats(range.from, range.to, project?.id)
  const s = stats.data

  const focusBars = useMemo(() => (s ? toBars(s.focus.by_day, today) : []), [s, today])
  const doneBars = useMemo(() => (s ? toBars(s.tasks.completed_by_day, today) : []), [s, today])
  const runBars = useMemo(() => (s ? toBars(s.agents.runs_by_day, today) : []), [s, today])
  const hours = useMemo(() => (s ? s.focus.by_hour.map((v, h) => ({ key: String(h), label: `${String(h).padStart(2, '0')}:00`, short: h % 3 === 0 ? String(h) : '', value: v })) : []), [s])

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8 md:pt-14">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <ChartColumn className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">Stats</h1>
          <p className="truncate text-[13px] text-muted">Your focus, tasks and projects over time{project ? ` in ${project.name}` : ''}.</p>
        </div>
        <Segmented<RangeKind> label="Range" value={kind} onChange={setKind} size="sm"
          options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'half', label: '6 months' }, { value: 'custom', label: 'Custom' }]} />
      </div>
      {kind === 'custom' && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px]">
          <label className="flex items-center gap-2">From
            <Input type="date" className="w-auto" value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} />
          </label>
          <label className="flex items-center gap-2">to
            <Input type="date" className="w-auto" value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} />
          </label>
        </div>
      )}
      {stats.isError && <p className="mb-3 text-[13px] text-error">{errorMessage(stats.error)}</p>}

      {s && s.focus.sessions === 0 && s.tasks.completed === 0 && s.focus.heatmap.every((d) => d.value === 0) ? (
        <Card>
          <EmptyState icon={<ChartColumn className="h-5 w-5" />} title="Nothing to count yet"
            description="Finish a focus session or complete a task, and your progress, streaks and heatmap appear here."
            action={<Link to="/focus"><Button variant="primary">Start focusing</Button></Link>} />
        </Card>
      ) : s && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Focused" value={formatMinutes(s.focus.total_minutes)} sub={`${s.focus.sessions} session${s.focus.sessions === 1 ? '' : 's'}`} />
            <StatTile label="Daily average" value={formatMinutes(Math.round(s.focus.daily_average_minutes))} sub={`over ${days(s.focus.by_day.length)}`} />
            <StatTile label="Streak" value={days(s.focus.current_streak)} sub={`longest ${days(s.focus.longest_streak)}`} />
            <StatTile label="Tasks done" value={count(s.tasks.completed)} sub={`${s.tasks.created} added · ${s.tasks.overdue_now} overdue now`} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <Section title={focusBars.length < s.focus.by_day.length ? 'Focus per week' : 'Focus per day'} icon={<ChartColumn />}>
              <BarChart data={focusBars} height={200} />
            </Section>
            <Section title="Top tasks by focus" icon={<Target />}>
              <HBars format={formatMinutes} empty="Link a task on the Focus page to see where your time goes."
                rows={s.tasks.top_by_focus.map((t) => ({ key: t.task_id, label: <Link to={`/tasks?task=${t.task_id}`} className="hover:underline">{t.title}</Link>, value: t.minutes }))} />
            </Section>
          </div>

          <Section title="Last 6 months" icon={<Grid3x3 />}>
            <Heatmap days={s.focus.heatmap} today={today} />
          </Section>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section title="When you focus" icon={<Clock />}>
              <BarChart data={hours} height={140} />
            </Section>
            <Section title="Sessions" icon={<Target />}>
              <SplitBar a={s.focus.completed} b={s.focus.cut_short} labels={['Finished', 'Cut short']} />
              <p className="mt-3 text-[12.5px] text-muted">A session is cut short when it is skipped or reset after at least a minute.</p>
            </Section>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section title="Tasks completed" icon={<SquareCheckBig />}>
              <BarChart data={doneBars} height={140} format={count} />
              <p className="mt-2 text-[12.5px] text-muted tabular-nums">{s.tasks.created} added, {s.tasks.completed} completed in this range.</p>
            </Section>
            <Section title="Projects" icon={<FolderKanban />}>
              {s.projects.length === 0 ? <p className="text-[13px] text-muted">No focus or completed tasks in this range.</p> : (
                <table className="w-full text-[13px]">
                  <thead className="text-left text-[11.5px] uppercase tracking-wider text-muted">
                    <tr><th className="pb-1.5 font-semibold">Project</th><th className="pb-1.5 text-right font-semibold">Focus</th><th className="pb-1.5 text-right font-semibold">Tasks done</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {s.projects.map((p) => (
                      <tr key={p.project_id ?? 'none'}>
                        <td className="py-1.5"><span className="flex items-center gap-2"><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color ?? 'var(--border-strong)' }} /><span className="truncate">{p.name}</span></span></td>
                        <td className="py-1.5 text-right tabular-nums">{formatMinutes(p.focus_minutes)}</td>
                        <td className="py-1.5 text-right tabular-nums">{p.tasks_completed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          </div>

          <Section title="Agent activity" icon={<Bot />} action={<Link to="/settings/usage" className="text-[12.5px] font-medium text-accent hover:underline">Usage and cost</Link>}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_280px]">
              <div>
                <p className="mb-2 text-[12.5px] text-muted tabular-nums">{s.agents.runs} agent run{s.agents.runs === 1 ? '' : 's'}</p>
                <BarChart data={runBars} height={90} format={count} />
              </div>
              <div>
                <p className="mb-2 text-[12.5px] text-muted">Document edits</p>
                <SplitBar a={s.agents.documents_by_you} b={s.agents.documents_by_agents} labels={['By you', 'By agents']} />
              </div>
            </div>
          </Section>
        </div>
      )}
    </div>
  )
}
