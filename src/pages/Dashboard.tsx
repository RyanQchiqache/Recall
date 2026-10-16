import { ArrowRight, BookOpen, CalendarClock, CalendarDays, ChevronDown, Clock3, Flame, FlaskConical, GraduationCap, Inbox, Layers, Play, Plus, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { diffDays } from '../../shared/dates.ts';
import type { Course, Program, Section, Semester } from '../../shared/types.ts';
import { useHierarchy } from '../components/HierarchyDialogs.tsx';
import { PageHeader, SectionTitle } from '../components/layout/AppShell.tsx';
import { Button, LinkButton } from '../components/ui/Button.tsx';
import { Alert, Badge, EmptyState, ErrorState, PageLoader, Panel } from '../components/ui/Feedback.tsx';
import { Field, Input } from '../components/ui/Form.tsx';
import { useToast } from '../components/ui/Toast.tsx';
import { api, errorMessage, qs } from '../lib/api.ts';
import { formatDate, greeting, plural } from '../lib/format.ts';
import { invalidateContent, queryClient, useDashboard, useTree } from '../lib/queries.ts';
import { cn, courseVars } from '../lib/util.ts';
import type { DashboardData } from '../../shared/types.ts';

export function Dashboard() {
  const dash = useDashboard();
  const [resumeOnboarding, setResumeOnboarding] = useState(() => readOnboardingState() !== null);
  if (dash.isLoading) return <PageLoader />;
  if (dash.error) return <ErrorState error={dash.error} onRetry={() => dash.refetch()} />;
  const d = dash.data!;
  if (!d.hasContent || resumeOnboarding) {
    return <Onboarding onProgress={() => setResumeOnboarding(true)} onDone={() => setResumeOnboarding(false)} />;
  }
  return <DashboardContent d={d} />;
}

function DashboardContent({ d }: { d: DashboardData }) {
  const h = useHierarchy();
  const toast = useToast();
  const tree = useTree(true);
  const navigate = useNavigate();
  const sem = d.currentSemester;
  const studyHref = `/study/new${qs({ semester: sem?.id })}`;
  const configuredSemesterId = d.settings.currentSemesterId;
  const semesters = (tree.data ?? []).flatMap((p) =>
    p.semesters
      .filter((s) => !s.archivedAt || s.id === configuredSemesterId)
      .map((s) => ({ id: s.id, label: `${p.title} › ${s.title}${s.archivedAt ? ' (archived)' : ''}` })),
  );
  const selectedSemesterId = configuredSemesterId && semesters.some((s) => s.id === configuredSemesterId) ? configuredSemesterId : sem?.id;
  const os = d.openSession;

  return (
    <>
      <PageHeader
        docTitle="Dashboard"
        title={`${greeting()}.`}
        subtitle={
          <span className="flex flex-col gap-y-0.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2">
            <span>{formatDate(d.today, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
            {sem && (
              <>
                <span aria-hidden className="hidden sm:inline">·</span>
                <label className="sr-only" htmlFor="current-sem">
                  Current semester
                </label>
                <span className="relative inline-flex max-w-full items-center self-start sm:self-auto">
                <select
                  id="current-sem"
                  className="max-w-full cursor-pointer appearance-none truncate rounded-md bg-transparent pr-5 pl-0 font-medium text-text-2 [field-sizing:content] hover:text-text"
                  value={selectedSemesterId}
                  onChange={async (e) => {
                    try {
                      await api.patch('/api/settings', { currentSemesterId: e.target.value });
                      queryClient.invalidateQueries({ queryKey: ['settings'] });
                      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                >
                  {semesters.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-0 size-3.5 text-muted" aria-hidden />
                </span>
              </>
            )}
          </span>
        }
        actions={
          <>
            <Button icon={<Plus className="size-4" />} onClick={() => h.create('course', sem?.id)}>
              Create course
            </Button>
            <LinkButton to={studyHref} variant="primary" icon={<Play className="size-4 fill-current" />}>
              Start session
            </LinkButton>
          </>
        }
      />

      {d.demoLoaded && (
        <Alert
          tone="info"
          className="mb-6"
          title="Demo content is loaded"
          action={
            <Button
              size="sm"
              variant="ghost"
              icon={<X className="size-4" />}
              onClick={async () => {
                try {
                  await api.del('/api/demo');
                  invalidateContent();
                  toast.success('Demo content removed');
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Remove demo
            </Button>
          }
        >
          The “M.Sc. Informatics (demo)” program is sample material, not an official syllabus. Remove it in one step whenever you like.
        </Alert>
      )}

      <div className={cn('grid gap-2 sm:gap-3', d.settings.showStreak ? 'grid-cols-3' : 'grid-cols-2')}>
        <StatTile icon={<Clock3 className="size-[18px]" />} label="Due today" value={d.counts.due}>
          {d.counts.due === 0
            ? d.counts.total > 0
              ? 'All caught up'
              : 'No cards yet'
            : `in ${plural(d.courses.filter((c) => c.counts.due > 0).length, 'course')}`}
        </StatTile>
        <StatTile icon={<Inbox className="size-[18px]" />} label="New cards" value={d.counts.new}>
          {d.counts.new > 0 ? 'ready to learn' : 'none waiting'}
        </StatTile>
        {d.settings.showStreak && (
          <StatTile
            icon={<Flame className="size-[18px]" />}
            label="Streak"
            value={d.streak.current}
            unit={d.streak.current === 1 ? 'day' : 'days'}
            aside={d.activity.some((a) => a.attempts > 0) ? <ActivityBars activity={d.activity} /> : undefined}
          >
            {d.streak.longest > 0 ? `Best ${plural(d.streak.longest, 'day')}` : 'Study today to start'}
          </StatTile>
        )}
      </div>

      {os && (
        <Panel className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
          <div className="min-w-0 flex-1 basis-60">
            <p className="text-xs font-medium text-muted">Open session · {os.status === 'paused' ? 'paused' : 'in progress'}</p>
            <p className="mt-0.5 truncate font-medium">{os.scopeLabel}</p>
          </div>
          <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={os.progress.selected} aria-valuenow={os.progress.completed + os.progress.unresolved} aria-label="Cards finished">
              <div className="h-full rounded-full bg-primary" style={{ width: `${((os.progress.completed + os.progress.unresolved) / Math.max(1, os.progress.selected)) * 100}%` }} />
            </div>
            <span className="shrink-0 text-sm text-muted tabular-nums">
              {os.progress.completed + os.progress.unresolved}/{os.progress.selected}
            </span>
          </div>
          <LinkButton to={`/study/${os.id}`} variant="primary" icon={<Play className="size-3.5 fill-current" />}>
            Resume
          </LinkButton>
        </Panel>
      )}

      <WorkloadPreview courses={d.courses} />

      <section className="mt-10" aria-labelledby="courses-h">
        <SectionTitle
          id="courses-h"
          action={
            <span className="flex items-center gap-3 text-sm text-muted">
              {sem && <span className="hidden truncate sm:inline">{`${sem.title} · ${plural(d.courses.length, 'course')}`}</span>}
              <Link to="/organize" className="font-medium text-primary-text hover:underline">
                Organize
              </Link>
            </span>
          }
        >
          Courses
        </SectionTitle>
        {d.courses.some((course) => course.examPlan) && (
          <p className="-mt-2 mb-4 text-[13px] text-muted">
            “Answering well” means the latest scheduled-review rating was Very good or Perfect.
          </p>
        )}
        {d.courses.length === 0 ? (
          <EmptyState
            icon={<BookOpen className="size-6" />}
            title="No courses in this semester yet"
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => h.create('course', sem?.id)}>
                Create course
              </Button>
            }
          >
            Add a course, then weekly sections and cards.
          </EmptyState>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {d.courses.map((c) => (
              <li key={c.id}>
                <CourseCard
                  course={c}
                  today={d.today}
                  onStudy={() => navigate(`/study/new${qs({ course: c.id })}`)}
                  onPlanStudy={() =>
                    navigate(
                      `/study/new${qs({
                        course: c.id,
                        mode: 'scheduled',
                        size: (c.examPlan?.learnToday ?? 0) + (c.examPlan?.reviseToday ?? 0),
                        includeNew: true,
                      })}`,
                    )
                  }
                  onClearExam={async () => {
                    try {
                      await api.patch(`/api/courses/${c.id}`, { examDate: null });
                      invalidateContent();
                      toast.success('Exam date cleared');
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {d.recentSections.length > 0 && (
        <section className="mt-10" aria-labelledby="recent-h">
          <SectionTitle id="recent-h">Recent sections</SectionTitle>
          <Panel as="div" className="divide-y divide-border overflow-hidden">
            {d.recentSections.map((s) => (
              <Link key={s.id} to={`/sections/${s.id}`} style={courseVars(s.courseColor)} className="flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-surface-2">
                <span className="size-2 shrink-0 rounded-[3px] bg-[var(--course)]" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{s.title}</span>
                  <span className="block truncate text-[13px] text-muted">{s.courseTitle}</span>
                </span>
                <span className="hidden shrink-0 gap-5 text-[13px] text-muted tabular-nums sm:flex">
                  <span className={cn(s.counts.due > 0 && 'font-medium text-primary-text')}>{s.counts.due} due</span>
                  <span>{s.counts.new} new</span>
                  <span>{plural(s.counts.total, 'card')}</span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted" aria-hidden />
              </Link>
            ))}
          </Panel>
        </section>
      )}
    </>
  );
}

function StatTile({ icon, label, value, unit, aside, children }: { icon: React.ReactNode; label: string; value: React.ReactNode; unit?: string; aside?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <Panel className="flex min-w-0 items-center gap-4 px-3.5 py-3 sm:px-5 sm:py-4">
      <span className="hidden size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted sm:flex" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-muted">{label}</p>
        <p className="mt-0.5 flex items-baseline gap-1.5">
          <span className="text-[26px] leading-none font-semibold tracking-[-0.02em] tabular-nums">{value}</span>
          {unit && <span className="text-sm text-text-2">{unit}</span>}
        </p>
        {children && <p className="mt-1 truncate text-xs text-muted">{children}</p>}
      </div>
      {aside}
    </Panel>
  );
}

function ActivityBars({ activity }: { activity: DashboardData['activity'] }) {
  const max = Math.max(1, ...activity.map((a) => a.attempts));
  const total = activity.reduce((n, a) => n + a.attempts, 0);
  return (
    <div className="hidden h-9 shrink-0 items-end gap-[3px] xl:flex" role="img" aria-label={`${plural(total, 'answer')} in the last 14 days`}>
      {activity.map((a) => (
        <span
          key={a.date}
          title={`${formatDate(a.date, { weekday: 'short', day: 'numeric', month: 'short' })}: ${plural(a.attempts, 'answer')}`}
          className={cn('w-[5px] rounded-[2px]', a.attempts > 0 ? 'bg-primary' : 'bg-surface-3')}
          style={{ height: a.attempts > 0 ? `${Math.max(22, (a.attempts / max) * 100)}%` : '14%' }}
        />
      ))}
    </div>
  );
}

function WorkloadPreview({ courses }: { courses: DashboardData['courses'] }) {
  const upcoming = courses.filter((course) => course.examPlan?.status === 'upcoming' && course.examPlan.days.length > 0);
  if (upcoming.length === 0) return null;

  return (
    <section className="mt-10" aria-labelledby="workload-h">
      <SectionTitle id="workload-h">Current seven-day plan</SectionTitle>
      <p className="-mt-2 mb-4 max-w-3xl text-[13px] text-muted">
        Scheduled reviews and planned new cards based on what remains now. Future ratings can move later review dates, so this is a current plan rather than a guarantee.
      </p>
      <ul className="flex flex-col gap-3">
        {upcoming.map((course) => {
          const plan = course.examPlan!;
          const nextLearningDay = plan.days.slice(1).find((day) => day.learn > 0);
          const studyAheadSize = (plan.days[0]?.total ?? 0) + (nextLearningDay?.learn ?? 0);
          return (
            <li key={course.id}>
              <Panel as="article" className="overflow-hidden p-0">
                <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                  <span className="size-2.5 shrink-0 rounded-[3px] bg-[var(--course)]" style={courseVars(course.color)} aria-hidden />
                  <Link to={`/courses/${course.id}`} className="min-w-0 flex-1 truncate text-sm font-semibold hover:underline">
                    {course.title}
                  </Link>
                  <span className="inline-flex items-center gap-1 text-xs text-muted">
                    <CalendarDays className="size-3.5" aria-hidden />
                    Exam {formatDate(course.examDate!, { day: 'numeric', month: 'short' })}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <div className="grid min-w-[700px] grid-cols-7 divide-x divide-border">
                    {plan.days.map((day, index) => (
                      <div key={day.date} className={cn('min-h-28 px-3 py-3', index === 0 && 'bg-primary-soft/55')}>
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium text-muted">{index === 0 ? 'Today' : formatDate(day.date, { weekday: 'short' })}</p>
                          {day.heavy && <Badge tone="warning">Heavy</Badge>}
                        </div>
                        <p className="mt-0.5 text-xs text-muted tabular-nums">{formatDate(day.date, { day: 'numeric', month: 'short' })}</p>
                        <p className={cn('mt-2 text-xl font-semibold tabular-nums', day.total > 0 ? 'text-text' : 'text-muted')}>{day.total}</p>
                        <p className="mt-0.5 text-xs text-muted tabular-nums">{day.learn} learn · {day.revise} revise</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
                  <p className="max-w-2xl text-xs text-muted">
                    Learning cards early reduces later learn counts. Scheduled ratings can add or move future reviews.
                  </p>
                  {nextLearningDay && (
                    <LinkButton
                      size="sm"
                      to={`/study/new${qs({ course: course.id, mode: 'scheduled', size: studyAheadSize, includeNew: true })}`}
                    >
                      Learn ahead
                    </LinkButton>
                  )}
                </div>
              </Panel>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CourseCard({
  course: c,
  today,
  onStudy,
  onPlanStudy,
  onClearExam,
}: {
  course: DashboardData['courses'][number];
  today: string;
  onStudy: () => void;
  onPlanStudy: () => void;
  onClearExam: () => void;
}) {
  const daysToExam = c.examDate ? diffDays(today, c.examDate) : null;
  const n = c.counts;
  const active = Math.max(0, n.total - n.suspended);
  // Reviewed cards that are not due yet: the share that is "on track".
  const onTrack = Math.max(0, active - n.due - n.new);
  const pct = active > 0 ? Math.round((onTrack / active) * 100) : 0;
  return (
    <Panel as="article" style={courseVars(c.color)} className="group relative flex h-full flex-col p-5 transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-card">
      <div className="flex items-start gap-3">
        <span className="mt-[7px] size-2.5 shrink-0 rounded-[3px] bg-[var(--course)]" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] leading-snug font-semibold">
            <Link to={`/courses/${c.id}`} className="after:absolute after:inset-0 hover:underline">
              {c.title}
            </Link>
          </h3>
          <p className="truncate text-[13px] text-muted">{[c.moduleCode, plural(c.sections.length, 'section')].filter(Boolean).join(' · ')}</p>
        </div>
        {daysToExam !== null && daysToExam >= 0 && (
          <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium', daysToExam <= 14 ? 'bg-warning-soft text-warning' : 'bg-surface-2 text-text-2')}>
            <CalendarClock className="size-3.5" aria-hidden />
            Exam {daysToExam === 0 ? 'today' : `in ${plural(daysToExam, 'day')}`}
          </span>
        )}
      </div>
      <dl className="mt-4 flex gap-8">
        {(
          [
            ['due', n.due, n.due > 0 ? 'text-primary-text' : 'text-muted'],
            ['new', n.new, n.new > 0 ? 'text-text' : 'text-muted'],
            [n.total === 1 ? 'card' : 'cards', n.total, 'text-text'],
          ] as const
        ).map(([label, value, tone]) => (
          <div key={label} className="flex flex-col-reverse">
            <dt className="text-[13px] text-muted">{label}</dt>
            <dd className={cn('text-[22px] leading-tight font-semibold tracking-[-0.01em] tabular-nums', tone)}>{value}</dd>
          </div>
        ))}
      </dl>
      <div
        className="mt-4 flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full bg-surface-3"
        role="img"
        aria-label={`${pct}% scheduled ahead, ${n.due} due, ${n.new} new`}
      >
        {onTrack > 0 && <span className="h-full rounded-full bg-primary" style={{ width: `${(onTrack / Math.max(1, active)) * 100}%` }} />}
        {n.due > 0 && <span className="h-full rounded-full bg-[color-mix(in_srgb,var(--primary)_38%,var(--surface-3))]" style={{ width: `${(n.due / Math.max(1, active)) * 100}%` }} />}
      </div>
      {c.examPlan?.status === 'upcoming' && (
        <div className="relative z-10 mt-4 rounded-lg border border-border bg-surface-2/60 p-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs font-medium text-muted">Learn today</p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums">{c.examPlan.learnToday}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted">Revise today</p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums">{c.examPlan.reviseToday}</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-[13px]">
            <span className="text-text-2 tabular-nums">
              {c.examPlan.learnedPercent}% learned · {c.examPlan.solidPercent}% answering well
            </span>
            <span className={cn('font-medium', c.examPlan.behindBy > 0 ? 'text-warning' : 'text-success')}>
              {c.examPlan.behindBy > 0 ? `Behind by ${plural(c.examPlan.behindBy, 'card')}` : 'On track'}
            </span>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-muted">
              {c.examPlan.bufferDays > 0 ? `${plural(c.examPlan.bufferDays, 'review-only day')} before the exam` : 'Plan recalculates each day'}
            </p>
            <Button
              size="sm"
              variant="primary"
              icon={<Play className="size-3 fill-current" />}
              onClick={onPlanStudy}
              disabled={c.examPlan.learnToday + c.examPlan.reviseToday === 0}
            >
              Study plan
            </Button>
          </div>
        </div>
      )}
      {c.examPlan?.status === 'passed' && (
        <div className="relative z-10 mt-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2/60 px-3 py-2.5">
          <span className="text-sm font-medium">Exam passed</span>
          <Button size="sm" variant="ghost" onClick={onClearExam}>Clear date</Button>
        </div>
      )}
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="truncate text-[13px] text-muted">
          {active === 0 ? 'No cards yet' : onTrack === 0 && n.due === 0 ? `${plural(n.new, 'card')} to learn` : n.due === 0 ? `${pct}% scheduled ahead · all caught up` : `${pct}% scheduled ahead`}
        </p>
        <Button size="sm" className="relative z-10" variant={n.due > 0 ? 'primary' : 'secondary'} icon={<Play className="size-3 fill-current" />} onClick={onStudy} disabled={n.total === 0}>
          Study
        </Button>
      </div>
    </Panel>
  );
}

// ---------------- First run ----------------

const ONBOARDING_KEY = 'recall:onboarding';
type OnboardingValues = { program: string; semester: string; start: string; end: string; course: string; section: string };
type OnboardingState = {
  step: number;
  ids: { program?: string; semester?: string; course?: string; section?: string };
  values: OnboardingValues;
};

function readOnboardingState(): OnboardingState | null {
  try {
    const raw = sessionStorage.getItem(ONBOARDING_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as OnboardingState;
    return saved.step >= 1 && saved.step <= 3 && saved.ids && saved.values ? saved : null;
  } catch {
    return null;
  }
}

function writeOnboardingState(state: OnboardingState | null) {
  try {
    if (state) sessionStorage.setItem(ONBOARDING_KEY, JSON.stringify(state));
    else sessionStorage.removeItem(ONBOARDING_KEY);
  } catch {
    // The wizard still works for this page load if session storage is unavailable.
  }
}

function Onboarding({ onProgress, onDone }: { onProgress: () => void; onDone: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [saved] = useState(readOnboardingState);
  const [step, setStep] = useState(saved?.step ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ids, setIds] = useState<OnboardingState['ids']>(saved?.ids ?? {});
  const [v, setV] = useState<OnboardingValues>(saved?.values ?? { program: '', semester: '', start: '', end: '', course: '', section: '' });

  useEffect(() => {
    if (step > 0) writeOnboardingState({ step, ids, values: v });
  }, [step, ids, v]);

  const steps = [
    { icon: GraduationCap, label: 'Study program', hint: 'A degree or personal study collection.' },
    { icon: CalendarClock, label: 'Semester', hint: 'A term with optional dates.' },
    { icon: BookOpen, label: 'Course', hint: 'One lecture or module.' },
    { icon: Layers, label: 'First section', hint: 'A lecture week, tutorial or reading.' },
    { icon: Sparkles, label: 'First card', hint: 'Write a question and its answer.' },
  ];

  const next = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (step === 0) {
        const p = await api.post<Program>('/api/programs', { title: v.program });
        const nextIds = { ...ids, program: p.id };
        setIds(nextIds);
        writeOnboardingState({ step: 1, ids: nextIds, values: v });
        onProgress();
      } else if (step === 1) {
        const s = await api.post<Semester>('/api/semesters', { programId: ids.program, title: v.semester, startDate: v.start || null, endDate: v.end || null });
        setIds((x) => ({ ...x, semester: s.id }));
      } else if (step === 2) {
        const c = await api.post<Course>('/api/courses', { semesterId: ids.semester, title: v.course });
        setIds((x) => ({ ...x, course: c.id }));
      } else if (step === 3) {
        const s = await api.post<Section>('/api/sections', { courseId: ids.course, title: v.section });
        writeOnboardingState(null);
        onDone();
        invalidateContent();
        navigate(`/cards/new?section=${s.id}&first=1`);
        return;
      }
      setStep(step + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const loadDemo = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ courseId: string }>('/api/demo');
      writeOnboardingState(null);
      onDone();
      invalidateContent();
      toast.success('Demo course loaded');
      navigate(`/courses/${r.courseId}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const fields: Record<number, React.ReactNode> = {
    0: (
      <Field label="Name of your study program" htmlFor="ob-0" hint="For example your degree. You can add more later.">
        <Input id="ob-0" autoFocus required value={v.program} onChange={(e) => setV({ ...v, program: e.target.value })} placeholder="e.g. M.Sc. Informatics" />
      </Field>
    ),
    1: (
      <div className="flex flex-col gap-4">
        <Field label="Semester" htmlFor="ob-1">
          <Input id="ob-1" autoFocus required value={v.semester} onChange={(e) => setV({ ...v, semester: e.target.value })} placeholder="e.g. Winter semester 2026/27" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts" optional htmlFor="ob-1s">
            <Input id="ob-1s" type="date" value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} />
          </Field>
          <Field label="Ends" optional htmlFor="ob-1e">
            <Input id="ob-1e" type="date" value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} />
          </Field>
        </div>
      </div>
    ),
    2: (
      <Field label="First course" htmlFor="ob-2" hint="You can set a colour, icon, module code and exam date later.">
        <Input id="ob-2" autoFocus required value={v.course} onChange={(e) => setV({ ...v, course: e.target.value })} placeholder="e.g. Computer Vision III" />
      </Field>
    ),
    3: (
      <Field label="First section" htmlFor="ob-3" hint="Next you’ll write your first card in it.">
        <Input id="ob-3" autoFocus required value={v.section} onChange={(e) => setV({ ...v, section: e.target.value })} placeholder="e.g. Week 01 — Introduction" />
      </Field>
    ),
  };

  return (
    <div className="mx-auto max-w-3xl py-4 sm:py-10">
      <PageHeader docTitle="Welcome" title="Welcome to your study workspace" subtitle="Everything stays on this computer. Set up your first course in four short steps." />
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <ol className="flex flex-col gap-1" aria-label="Setup steps">
          {steps.map((s, i) => (
            <li key={s.label} aria-current={i === step ? 'step' : undefined} className={cn('flex items-start gap-3 rounded-xl px-3 py-2.5', i === step && 'bg-surface shadow-soft')}>
              <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg', i < step ? 'bg-success-soft text-success' : i === step ? 'bg-primary text-on-primary' : 'bg-surface-3 text-muted')}>
                <s.icon className="size-4" aria-hidden />
              </span>
              <span>
                <span className={cn('block text-sm font-semibold', i > step && 'text-muted')}>{s.label}</span>
                <span className="block text-xs text-muted">{s.hint}</span>
              </span>
            </li>
          ))}
        </ol>
        <Panel className="p-6">
          <form onSubmit={next} className="flex flex-col gap-5">
            {fields[step]}
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm text-muted">
                Step {step + 1} of {steps.length}
              </span>
              <Button type="submit" variant="primary" loading={busy} icon={<ArrowRight className="size-4" />}>
                {step === 3 ? 'Create section & write first card' : 'Continue'}
              </Button>
            </div>
          </form>
          {step === 0 && (
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
              <p className="text-sm text-muted">Just looking around? Load a small, clearly labelled demo course you can remove in one click.</p>
              <Button onClick={loadDemo} disabled={busy} icon={<FlaskConical className="size-4" />}>
                Load demo course
              </Button>
            </div>
          )}
          {step > 0 && (
            <div className="mt-6 flex items-center justify-end border-t border-border pt-5">
              <Button
                variant="ghost"
                onClick={() => {
                  writeOnboardingState(null);
                  onDone();
                }}
              >
                Skip the rest for now
              </Button>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
