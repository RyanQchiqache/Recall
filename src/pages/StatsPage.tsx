import { BarChart3, Dumbbell, EyeOff, Flame, Play } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { addDays } from '../../shared/dates.ts';
import { MODE_LABEL, type StudyMode } from '../../shared/ratings.ts';
import { DailyBarChart, DistributionBar, Heatmap } from '../components/charts.tsx';
import { PageHeader, SectionTitle } from '../components/layout/AppShell.tsx';
import { ratingParts } from '../components/ratingUi.tsx';
import { Button, LinkButton } from '../components/ui/Button.tsx';
import { Badge, EmptyState, ErrorState, PageLoader, Panel, Stat } from '../components/ui/Feedback.tsx';
import { Field, Input, Segmented, Select } from '../components/ui/Form.tsx';
import { api, qs } from '../lib/api.ts';
import { formatDate, formatDateTime, formatDuration, percent, plural } from '../lib/format.ts';
import { queryClient, useDashboard, useSettings, useStats, useTree } from '../lib/queries.ts';

const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'custom', label: 'Custom' },
];

export function StatsPage() {
  const dash = useDashboard();
  const tree = useTree();
  const settings = useSettings();
  const today = dash.data?.today;
  const [range, setRange] = useState('30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [programId, setProgramId] = useState('');
  const [semesterId, setSemesterId] = useState('');
  const [courseId, setCourseId] = useState('');
  const [modeTab, setModeTab] = useState<StudyMode>('scheduled');

  const params = useMemo(() => {
    if (!today) return null;
    const end = range === 'custom' && to ? to : today;
    const start = range === 'custom' && from ? from : addDays(end, -(Number(range === 'custom' ? 30 : range) - 1));
    return { from: start, to: end, programId: programId || undefined, semesterId: semesterId || undefined, courseId: courseId || undefined };
  }, [today, range, from, to, programId, semesterId, courseId]);
  const stats = useStats(params ?? {});

  const programs = tree.data ?? [];
  const semesters = programs.filter((p) => !programId || p.id === programId).flatMap((p) => p.semesters);
  const courses = semesters.filter((s) => !semesterId || s.id === semesterId).flatMap((s) => s.courses);

  const hideActivityExtras = async () => {
    await api.patch('/api/settings', { showHeatmap: false, showStreak: false });
    queryClient.invalidateQueries({ queryKey: ['settings'] });
  };

  if (!params || stats.isLoading) return <PageLoader />;
  if (stats.error) return <ErrorState error={stats.error} onRetry={() => stats.refetch()} />;
  const d = stats.data!;
  const everStudied = d.heatmap.some((h) => h.attempts > 0) || d.recentSessions.length > 0;
  const ms = d.byMode[modeTab];
  const firstRecalled = ms.firstRatingCounts[3] + ms.firstRatingCounts[4];

  return (
    <>
      <PageHeader title="Statistics" subtitle={`Descriptive progress from your own ratings · days counted in ${d.timeZone}`} />

      <Panel className="mb-6 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Program" htmlFor="st-prog">
            <Select id="st-prog" value={programId} onChange={(e) => { setProgramId(e.target.value); setSemesterId(''); setCourseId(''); }}>
              <option value="">All programs</option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </Select>
          </Field>
          <Field label="Semester" htmlFor="st-sem">
            <Select id="st-sem" value={semesterId} onChange={(e) => { setSemesterId(e.target.value); setCourseId(''); }}>
              <option value="">All semesters</option>
              {semesters.map((s) => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </Select>
          </Field>
          <Field label="Course" htmlFor="st-course">
            <Select id="st-course" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
              <option value="">All courses</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text-2">Date range</span>
            <Segmented ariaLabel="Date range" value={range} onChange={setRange} options={RANGES} className="w-full" />
          </div>
        </div>
        {range === 'custom' && (
          <div className="mt-3 grid max-w-md grid-cols-2 gap-3">
            <Field label="From" htmlFor="st-from">
              <Input id="st-from" type="date" value={from || d.query.from} max={to || today} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To" htmlFor="st-to">
              <Input id="st-to" type="date" value={to || d.query.to} max={today} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
        )}
        <p className="mt-3 text-sm text-muted">
          Showing <strong className="font-medium text-text-2">{d.scopeLabel}</strong> · {formatDate(d.query.from)} – {formatDate(d.query.to)}
        </p>
      </Panel>

      {!everStudied ? (
        <EmptyState icon={<BarChart3 className="size-6" />} title="No study history yet" action={<LinkButton to="/study/new" variant="primary" icon={<Play className="size-4 fill-current" />}>Start your first session</LinkButton>}>
          Statistics appear after your first ratings. They describe what you did — they never estimate “mastery”.
          <span className="mt-3 block text-sm">
            Right now: {d.current.due} due · {d.current.new} new · {plural(d.current.total, 'card')}
          </span>
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border shadow-soft lg:grid-cols-5 [&>:last-child:nth-child(odd)]:col-span-2 lg:[&>:last-child:nth-child(odd)]:col-span-1">
            <Stat label="Due today" value={d.current.due} hint={`of ${plural(d.current.total, 'active card')}`} />
            <Stat label="New cards" value={d.current.new} hint="never scheduled" />
            <Stat label="Cards reviewed" value={d.totals.uniqueCards} hint={`unique · ${plural(d.totals.attempts, 'attempt')}`} />
            <Stat label="Active study time" value={formatDuration(d.totals.activeMs)} hint="excludes pauses and idle gaps" />
            <Stat label="Study days" value={d.totals.studyDays} hint={`in range · ${plural(d.totals.sessions, 'session')}`} />
          </div>

          <Panel className="mt-6 p-5">
            <DailyBarChart
              title="Answer attempts per day, by mode"
              data={d.days.map((x) => ({
                date: x.date,
                values: { scheduled: x.scheduled, practice: x.practice, test: x.test },
                extra: { unique: x.uniqueCards, time: formatDuration(x.activeMs) },
              }))}
              series={[
                { key: 'scheduled', label: 'Scheduled review', color: 'var(--series-1)' },
                { key: 'practice', label: 'Practice', color: 'var(--series-2)' },
                { key: 'test', label: 'Test once', color: 'var(--series-3)' },
              ]}
              extraColumns={[
                { key: 'unique', label: 'Unique cards' },
                { key: 'time', label: 'Active time' },
              ]}
              height={200}
            />
          </Panel>

          <div className="mt-6 grid gap-4 lg:grid-cols-[1.3fr_1fr]">
            <Panel className="p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-semibold">Recall by mode</h2>
                <Segmented
                  ariaLabel="Mode"
                  value={modeTab}
                  onChange={setModeTab}
                  options={(['scheduled', 'practice', 'test'] as StudyMode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }))}
                />
              </div>
              {ms.firstAttempts === 0 ? (
                <p className="text-muted">No {MODE_LABEL[modeTab].toLowerCase()} ratings in this range.</p>
              ) : (
                <>
                  <dl className="mb-5 grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-surface-2 p-3">
                      <dt className="text-sm text-muted">First-attempt recall</dt>
                      <dd className="text-2xl font-semibold tabular-nums">{percent(firstRecalled, ms.firstAttempts)}</dd>
                      <dd className="text-xs text-muted">
                        {firstRecalled} of {plural(ms.firstAttempts, 'first attempt')} rated Very good or Perfect
                      </dd>
                    </div>
                    <div className="rounded-xl bg-surface-2 p-3">
                      <dt className="text-sm text-muted">{modeTab === 'test' ? 'Recalled (self-assessed)' : 'Finished after repeats'}</dt>
                      <dd className="text-2xl font-semibold tabular-nums">{percent(ms.finishedAfterRepeats.finished, ms.finishedAfterRepeats.attemptedCards)}</dd>
                      <dd className="text-xs text-muted">
                        {ms.finishedAfterRepeats.finished} of {plural(ms.finishedAfterRepeats.attemptedCards, 'card-in-session')} ended on Very good/Perfect
                      </dd>
                    </div>
                  </dl>
                  <p className="mb-2 text-sm font-medium text-text-2">First-attempt ratings</p>
                  <DistributionBar parts={ratingParts(ms.firstRatingCounts)} total={ms.firstAttempts} label="First-attempt ratings" />
                  <p className="mt-4 text-xs text-muted">
                    {plural(ms.attempts, 'attempt')} on {plural(ms.uniqueCards, 'unique card')}. These are personal confidence ratings, not exam scores.
                  </p>
                </>
              )}
            </Panel>

            <Panel className="p-5">
              <h2 className="mb-1 font-semibold">Weak sections</h2>
              <p className="mb-4 text-sm text-muted">Share of first attempts rated Bad or Good in this range (all modes).</p>
              {d.weakSections.length === 0 ? (
                <p className="text-muted">No weak first attempts in this range.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {d.weakSections.map((w) => (
                    <li key={w.sectionId} className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <Link to={`/sections/${w.sectionId}`} className="block truncate font-medium hover:underline">
                          {w.sectionTitle}
                        </Link>
                        <span className="block truncate text-xs text-muted">{w.courseTitle}</span>
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                          <div className="h-full rounded-full bg-[var(--rating-bad)]" style={{ width: `${(w.weakFirst / w.firstAttempts) * 100}%` }} />
                        </div>
                      </div>
                      <span className="shrink-0 text-right text-sm tabular-nums">
                        {w.weakFirst} of {w.firstAttempts}
                      </span>
                      <LinkButton to={`/study/new${qs({ sections: w.sectionId, mode: 'practice' })}`} size="sm" variant="ghost" aria-label={`Practise ${w.sectionTitle}`}>
                        <Dumbbell className="size-4" />
                      </LinkButton>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          {(settings.data?.showHeatmap || settings.data?.showStreak) && (
            <Panel className="mt-6 p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-semibold">Last 26 weeks</h2>
                <div className="flex items-center gap-2">
                  {settings.data?.showStreak && (
                    <Badge tone="neutral" icon={<Flame className="size-3.5" aria-hidden />}>
                      {d.streak.current ? `${plural(d.streak.current, 'day')} in a row` : 'No current streak'} · longest {d.streak.longest}
                    </Badge>
                  )}
                  <Button size="sm" variant="ghost" icon={<EyeOff className="size-4" />} onClick={hideActivityExtras}>
                    Hide
                  </Button>
                </div>
              </div>
              {settings.data?.showHeatmap && <Heatmap data={d.heatmap} label="Answer attempts per day over the last 26 weeks" />}
              <p className="mt-2 text-xs text-muted">Optional and purely informational. Hide the heatmap and streak any time in Settings.</p>
            </Panel>
          )}

          <section className="mt-8" aria-labelledby="sess-h">
            <SectionTitle id="sess-h">Recent sessions</SectionTitle>
            <Panel as="div" className="divide-y divide-border overflow-hidden">
              {d.recentSessions.map((s) => (
                <Link key={s.id} to={s.status === 'active' || s.status === 'paused' ? `/study/${s.id}` : `/study/${s.id}/results`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-surface-2">
                  <span className="min-w-0 flex-1 basis-56">
                    <span className="block truncate font-medium">{s.scopeLabel}</span>
                    <span className="text-sm text-muted">
                      {MODE_LABEL[s.mode]} · {formatDateTime(s.startedAt)}
                    </span>
                  </span>
                  <span className="text-sm text-text-2 tabular-nums">
                    {s.progress.attempted}/{s.progress.selected} cards · {plural(s.progress.totalAttempts, 'attempt')} · {formatDuration(s.activeMs)}
                  </span>
                  <Badge tone={s.status === 'completed' ? 'success' : s.status === 'ended' ? 'neutral' : 'primary'}>{s.status === 'active' ? 'open' : s.status}</Badge>
                </Link>
              ))}
            </Panel>
          </section>
        </>
      )}
    </>
  );
}
