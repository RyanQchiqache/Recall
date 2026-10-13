import { ArrowRight, BookOpen, CalendarClock, FlaskConical, GraduationCap, Layers, Play, Plus, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { diffDays } from '../../shared/dates.ts';
import type { Course, Program, Section, Semester } from '../../shared/types.ts';
import { DailyBarChart } from '../components/charts.tsx';
import { CourseIcon } from '../components/CourseIcon.tsx';
import { useHierarchy } from '../components/HierarchyDialogs.tsx';
import { PageHeader, SectionTitle } from '../components/layout/AppShell.tsx';
import { Button, LinkButton } from '../components/ui/Button.tsx';
import { Alert, EmptyState, ErrorState, PageLoader, Panel } from '../components/ui/Feedback.tsx';
import { Field, Input } from '../components/ui/Form.tsx';
import { useToast } from '../components/ui/Toast.tsx';
import { api, errorMessage, qs } from '../lib/api.ts';
import { formatDate, greeting, plural } from '../lib/format.ts';
import { invalidateContent, queryClient, useDashboard, useTree } from '../lib/queries.ts';
import { cn, courseVars } from '../lib/util.ts';
import type { DashboardData } from '../../shared/types.ts';

export function Dashboard() {
  const dash = useDashboard();
  if (dash.isLoading) return <PageLoader />;
  if (dash.error) return <ErrorState error={dash.error} onRetry={() => dash.refetch()} />;
  const d = dash.data!;
  if (!d.hasContent) return <Onboarding />;
  return <DashboardContent d={d} />;
}

function DashboardContent({ d }: { d: DashboardData }) {
  const h = useHierarchy();
  const toast = useToast();
  const tree = useTree();
  const navigate = useNavigate();
  const sem = d.currentSemester;
  const studyHref = `/study/new${qs({ semester: sem?.id })}`;
  const semesters = (tree.data ?? []).flatMap((p) => p.semesters.map((s) => ({ id: s.id, label: `${p.title} › ${s.title}` })));
  const totalActivity = d.activity.reduce((n, a) => n + a.attempts, 0);
  const os = d.openSession;

  return (
    <>
      <PageHeader
        docTitle="Dashboard"
        title={`${greeting()}.`}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2">
            <span>{formatDate(d.today, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
            {sem && (
              <>
                <span aria-hidden>·</span>
                <label className="sr-only" htmlFor="current-sem">
                  Current semester
                </label>
                <select
                  id="current-sem"
                  className="max-w-full cursor-pointer rounded-md bg-transparent font-medium text-text-2 hover:text-text"
                  value={sem.id}
                  onChange={async (e) => {
                    await api.patch('/api/settings', { currentSemesterId: e.target.value });
                    queryClient.invalidateQueries({ queryKey: ['settings'] });
                    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
                  }}
                >
                  {semesters.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
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

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Study hero */}
        <Panel className="relative overflow-hidden p-6">
          <div className="pointer-events-none absolute -top-16 -right-16 size-56 rounded-full bg-primary-soft opacity-70 blur-2xl" aria-hidden />
          <div className="relative">
            <p className="text-sm font-medium text-muted">{sem ? sem.title : 'All courses'}</p>
            <div className="mt-3 flex flex-wrap items-end gap-x-8 gap-y-3">
              <div>
                <div className="text-5xl font-semibold tracking-tight tabular-nums">{d.counts.due}</div>
                <div className="mt-1 text-sm text-muted">{d.counts.due === 1 ? 'card due' : 'cards due'} today</div>
              </div>
              <div>
                <div className="text-3xl font-semibold tracking-tight text-text-2 tabular-nums">{d.counts.new}</div>
                <div className="mt-1 text-sm text-muted">new {d.counts.new === 1 ? 'card' : 'cards'}</div>
              </div>
              <div>
                <div className="text-3xl font-semibold tracking-tight text-text-2 tabular-nums">{d.counts.total}</div>
                <div className="mt-1 text-sm text-muted">in total</div>
              </div>
            </div>
            <div className="mt-6 flex flex-wrap gap-2">
              {os ? (
                <LinkButton to={`/study/${os.id}`} variant="primary" size="lg" icon={<Play className="size-4 fill-current" />}>
                  Resume session
                </LinkButton>
              ) : (
                <LinkButton to={studyHref} variant="primary" size="lg" icon={<Play className="size-4 fill-current" />}>
                  {d.counts.due > 0 ? `Review ${plural(d.counts.due, 'due card')}` : 'Start session'}
                </LinkButton>
              )}
              {os && (
                <LinkButton to={studyHref} size="lg">
                  New session
                </LinkButton>
              )}
            </div>
            {d.counts.due === 0 && d.counts.new === 0 && d.counts.total > 0 && !os && (
              <p className="mt-3 text-sm text-muted">Nothing is due. You can still practise any cards — practice doesn’t change your schedule.</p>
            )}
          </div>
        </Panel>

        {/* Resume / activity */}
        {os ? (
          <Panel className="flex flex-col p-6">
            <p className="text-sm font-medium text-muted">Open session · {os.status === 'paused' ? 'paused' : 'in progress'}</p>
            <h2 className="mt-1 line-clamp-2 text-lg font-semibold">{os.scopeLabel}</h2>
            <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={os.progress.selected} aria-valuenow={os.progress.completed + os.progress.unresolved} aria-label="Cards finished">
              <div className="h-full rounded-full bg-primary" style={{ width: `${((os.progress.completed + os.progress.unresolved) / Math.max(1, os.progress.selected)) * 100}%` }} />
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <div>
                <dt className="text-muted">Attempted</dt>
                <dd className="font-semibold tabular-nums">
                  {os.progress.attempted}/{os.progress.selected}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Completed</dt>
                <dd className="font-semibold tabular-nums">{os.progress.completed}</dd>
              </div>
              <div>
                <dt className="text-muted">Attempts</dt>
                <dd className="font-semibold tabular-nums">{os.progress.totalAttempts}</dd>
              </div>
            </dl>
            <div className="mt-auto pt-5">
              <LinkButton to={`/study/${os.id}`} variant="secondary" icon={<ArrowRight className="size-4" />}>
                Resume
              </LinkButton>
            </div>
          </Panel>
        ) : (
          <Panel className="p-6">
            {totalActivity > 0 ? (
              <DailyBarChart
                title="Answer attempts, last 14 days"
                data={d.activity.map((a) => ({ date: a.date, values: { attempts: a.attempts }, extra: { unique: a.uniqueCards } }))}
                series={[{ key: 'attempts', label: 'Attempts', color: 'var(--primary)' }]}
                extraColumns={[{ key: 'unique', label: 'Unique cards' }]}
                height={130}
              />
            ) : (
              <div className="flex h-full flex-col justify-center">
                <p className="text-sm font-medium text-text-2">Activity</p>
                <p className="mt-2 text-muted">No study activity in the last 14 days yet. Your first session will show up here.</p>
              </div>
            )}
          </Panel>
        )}
      </div>

      <section className="mt-10" aria-labelledby="courses-h">
        <SectionTitle
          id="courses-h"
          action={
            <Link to="/organize" className="text-sm font-medium text-primary-text hover:underline">
              Organize
            </Link>
          }
        >
          {sem ? `Courses in ${sem.title}` : 'Courses'}
        </SectionTitle>
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
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {d.courses.map((c) => (
              <li key={c.id}>
                <CourseCard course={c} today={d.today} onStudy={() => navigate(`/study/new${qs({ course: c.id })}`)} />
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
              <Link key={s.id} to={`/sections/${s.id}`} style={courseVars(s.courseColor)} className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-surface-2">
                <span className="h-8 w-1 shrink-0 rounded-full bg-[var(--course)]" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{s.title}</span>
                  <span className="block truncate text-sm text-muted">{s.courseTitle}</span>
                </span>
                <span className="hidden shrink-0 gap-4 text-sm text-muted tabular-nums sm:flex">
                  <span>{s.counts.due} due</span>
                  <span>{s.counts.new} new</span>
                  <span>{s.counts.total} cards</span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted" aria-hidden />
              </Link>
            ))}
          </Panel>
        </section>
      )}
      {os && totalActivity > 0 && (
        <section className="mt-10" aria-label="Activity">
          <Panel className="p-6">
            <DailyBarChart
              title="Answer attempts, last 14 days"
              data={d.activity.map((a) => ({ date: a.date, values: { attempts: a.attempts }, extra: { unique: a.uniqueCards } }))}
              series={[{ key: 'attempts', label: 'Attempts', color: 'var(--primary)' }]}
              extraColumns={[{ key: 'unique', label: 'Unique cards' }]}
              height={110}
            />
          </Panel>
        </section>
      )}
    </>
  );
}

function CourseCard({ course: c, today, onStudy }: { course: DashboardData['courses'][number]; today: string; onStudy: () => void }) {
  const daysToExam = c.examDate ? diffDays(today, c.examDate) : null;
  return (
    <Panel as="article" style={courseVars(c.color)} className="group relative flex h-full flex-col overflow-hidden p-5 transition-shadow duration-150 hover:shadow-pop">
      <div className="absolute inset-x-0 top-0 h-1 bg-[var(--course)]" aria-hidden />
      <div className="flex items-start gap-3">
        <CourseIcon icon={c.icon} color={c.color} />
        <div className="min-w-0 flex-1">
          <h3 className="leading-snug font-semibold">
            <Link to={`/courses/${c.id}`} className="after:absolute after:inset-0 hover:underline">
              {c.title}
            </Link>
          </h3>
          <p className="truncate text-sm text-muted">{[c.moduleCode, plural(c.sections.length, 'section')].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      {daysToExam !== null && daysToExam >= 0 && (
        <p className={cn('mt-3 inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium', daysToExam <= 14 ? 'bg-warning-soft text-warning' : 'bg-surface-2 text-text-2')}>
          <CalendarClock className="size-3.5" aria-hidden />
          Exam {daysToExam === 0 ? 'today' : `in ${plural(daysToExam, 'day')}`}
        </p>
      )}
      <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-muted">Due</dt>
          <dd className="text-lg font-semibold tabular-nums">{c.counts.due}</dd>
        </div>
        <div>
          <dt className="text-muted">New</dt>
          <dd className="text-lg font-semibold tabular-nums">{c.counts.new}</dd>
        </div>
        <div>
          <dt className="text-muted">Cards</dt>
          <dd className="text-lg font-semibold tabular-nums">{c.counts.total}</dd>
        </div>
      </dl>
      <div className="relative z-10 mt-4 flex gap-2">
        <Button size="sm" variant={c.counts.due > 0 ? 'primary' : 'secondary'} icon={<Play className="size-3.5 fill-current" />} onClick={onStudy} disabled={c.counts.total === 0}>
          Study
        </Button>
      </div>
    </Panel>
  );
}

// ---------------- First run ----------------

function Onboarding() {
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ids, setIds] = useState<{ program?: string; semester?: string; course?: string; section?: string }>({});
  const [v, setV] = useState({ program: '', semester: '', start: '', end: '', course: '', section: '' });

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
        setIds((x) => ({ ...x, program: p.id }));
      } else if (step === 1) {
        const s = await api.post<Semester>('/api/semesters', { programId: ids.program, title: v.semester, startDate: v.start || null, endDate: v.end || null });
        setIds((x) => ({ ...x, semester: s.id }));
      } else if (step === 2) {
        const c = await api.post<Course>('/api/courses', { semesterId: ids.semester, title: v.course });
        setIds((x) => ({ ...x, course: c.id }));
      } else if (step === 3) {
        const s = await api.post<Section>('/api/sections', { courseId: ids.course, title: v.section });
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
        </Panel>
      </div>
    </div>
  );
}
