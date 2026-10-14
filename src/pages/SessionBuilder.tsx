import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ClipboardCheck, Dumbbell, Play, RotateCcw, Square } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { StudyMode } from '../../shared/ratings.ts';
import { SESSION_SIZE_PRESETS } from '../../shared/settings.ts';
import type { SessionFilters, SessionOrdering, SessionPreview, SessionRequest, SessionState, TreeProgram } from '../../shared/types.ts';
import { PageHeader } from '../components/layout/AppShell.tsx';
import { Button, LinkButton } from '../components/ui/Button.tsx';
import { ConfirmDialog } from '../components/ui/Dialog.tsx';
import { Alert, Badge, PageLoader, Panel, Spinner } from '../components/ui/Feedback.tsx';
import { Checkbox, Field, Input, Segmented, Select, Switch } from '../components/ui/Form.tsx';
import { useToast } from '../components/ui/Toast.tsx';
import { ApiError, api, errorMessage } from '../lib/api.ts';
import { plural } from '../lib/format.ts';
import { invalidateContent, useOpenSession, useSettings, useTags, useTree } from '../lib/queries.ts';
import { cn, courseVars, useDebounced } from '../lib/util.ts';

function findSemesterOf(tree: TreeProgram[], pred: (courseId: string, sectionIds: string[]) => boolean): string | null {
  for (const p of tree) for (const s of p.semesters) for (const c of s.courses) if (pred(c.id, c.sections.map((x) => x.id))) return s.id;
  return null;
}

export function SessionBuilder() {
  const tree = useTree();
  const settings = useSettings();
  if (tree.isLoading || settings.isLoading) return <PageLoader />;
  return <Builder tree={tree.data ?? []} defaults={settings.data!} />;
}

function Builder({ tree, defaults }: { tree: TreeProgram[]; defaults: NonNullable<ReturnType<typeof useSettings>['data']> }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const open = useOpenSession();
  const tags = useTags();

  const cardIds = useMemo(() => (params.get('cards') ?? '').split(',').filter(Boolean), [params]);
  const initial = useMemo(() => {
    const sections = new Set((params.get('sections') ?? '').split(',').filter(Boolean));
    const courses = new Set((params.get('course') ?? '').split(',').filter(Boolean));
    const semParam = params.get('semester');
    let shownSemester = semParam ?? null;
    if (!shownSemester && courses.size) shownSemester = findSemesterOf(tree, (cid) => courses.has(cid));
    if (!shownSemester && sections.size) shownSemester = findSemesterOf(tree, (_c, sids) => sids.some((x) => sections.has(x)));
    if (!shownSemester) shownSemester = defaults.currentSemesterId ?? tree[0]?.semesters[0]?.id ?? null;
    return { sections, courses, wholeSemester: semParam, shownSemester };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [shownSemester, setShownSemester] = useState<string | null>(initial.shownSemester);
  const [wholeSemester, setWholeSemester] = useState<string | null>(initial.wholeSemester);
  const [courseIds, setCourseIds] = useState<Set<string>>(initial.courses);
  const [sectionIds, setSectionIds] = useState<Set<string>>(initial.sections);
  const [mode, setMode] = useState<StudyMode>((params.get('mode') as StudyMode) || (cardIds.length ? 'practice' : 'scheduled'));
  const requestedSize = Number(params.get('size'));
  const initialSize = cardIds.length || (Number.isInteger(requestedSize) && requestedSize > 0 ? requestedSize : defaults.defaultSessionSize);
  const [size, setSize] = useState<number>(initialSize);
  const [custom, setCustom] = useState(!SESSION_SIZE_PRESETS.includes(initialSize as never));
  const [ordering, setOrdering] = useState<SessionOrdering>('default');
  const [maxAttempts, setMaxAttempts] = useState(defaults.defaultMaxAttempts);
  const [filters, setFilters] = useState<SessionFilters>({
    includeNew: params.has('includeNew') ? params.get('includeNew') === '1' : defaults.includeNewByDefault,
    tags: [],
    bookmarkedOnly: false,
    status: 'any',
    weakBasis: 'all',
  });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [endOpen, setEndOpen] = useState(false);
  const [seed] = useState(() => {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return values[0];
  });

  const semesters = tree.flatMap((p) => p.semesters.filter((s) => !s.archivedAt).map((s) => ({ ...s, programTitle: p.title })));
  const sem = semesters.find((s) => s.id === shownSemester) ?? null;

  const request: SessionRequest = {
    mode,
    scope: cardIds.length ? { cardIds } : { semesterId: wholeSemester, courseIds: [...courseIds], sectionIds: [...sectionIds] },
    filters,
    ordering,
    size: Math.max(1, size || 1),
    maxAttempts: mode === 'test' ? 1 : maxAttempts,
    seed,
  };
  const debounced = useDebounced(request, 200);
  const hasScope = cardIds.length > 0 || !!wholeSemester || courseIds.size > 0 || sectionIds.size > 0;
  const preview = useQuery({
    queryKey: ['preview', debounced],
    queryFn: () => api.post<SessionPreview>('/api/sessions/preview', debounced),
    enabled: hasScope,
    placeholderData: (p) => p,
  });
  const pv = hasScope ? preview.data : undefined;

  const toggleCourse = (id: string) => {
    const n = new Set(courseIds);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setCourseIds(n);
  };
  const toggleSection = (id: string) => {
    const n = new Set(sectionIds);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSectionIds(n);
  };
  const clearScope = () => {
    setWholeSemester(null);
    setCourseIds(new Set());
    setSectionIds(new Set());
  };

  const start = async (acceptSmaller: boolean) => {
    setError(null);
    setStarting(true);
    try {
      const s = await api.post<SessionState>('/api/sessions', { ...request, acceptSmaller });
      invalidateContent();
      navigate(`/study/${s.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'session_open') {
        setError('Another session is still open. Resume it, or end it to start this one.');
        void open.refetch();
      } else setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const available = pv?.available ?? 0;
  const smaller = !!pv && available > 0 && available < request.size;

  return (
    <>
      <PageHeader title="Start a study session" subtitle="Choose what to study, how, and how many unique cards." />

      {open.data && (
        <Alert
          tone="warning"
          className="mb-6"
          title="You have an open session"
          action={
            <>
              <LinkButton to={`/study/${open.data.id}`} size="sm" variant="primary">
                Resume
              </LinkButton>
              <Button size="sm" icon={<Square className="size-3.5" />} onClick={() => setEndOpen(true)}>
                End it
              </Button>
            </>
          }
        >
          “{open.data.scopeLabel}” — {open.data.progress.completed + open.data.progress.unresolved} of {open.data.progress.selected} cards finished. Only one session can be open at a time.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          {/* Scope */}
          <Panel className="p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">1. What to study</h2>
              {!cardIds.length && hasScope && (
                <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} onClick={clearScope}>
                  Clear selection
                </Button>
              )}
            </div>
            {cardIds.length ? (
              <Alert tone="info">
                A fixed set of {plural(cardIds.length, 'card')} from your previous session. <button className="font-medium underline" onClick={() => navigate('/study/new')}>Choose a different scope</button>
              </Alert>
            ) : semesters.length === 0 ? (
              <p className="text-muted">Create a semester, course and some cards first.</p>
            ) : (
              <>
                <Field label="Semester" htmlFor="sb-sem">
                  <Select id="sb-sem" value={shownSemester ?? ''} onChange={(e) => setShownSemester(e.target.value)}>
                    {semesters.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.programTitle} › {s.title}
                      </option>
                    ))}
                  </Select>
                </Field>
                {sem && (
                  <div className="mt-4 flex flex-col gap-2">
                    <Checkbox
                      checked={wholeSemester === sem.id}
                      onChange={(e) => setWholeSemester(e.target.checked ? sem.id : null)}
                      label={<span className="font-medium">All courses in {sem.title}</span>}
                      description={`${plural(sem.counts.total, 'card')} · ${sem.counts.due} due · ${sem.counts.new} new`}
                    />
                    <ul className="mt-2 flex flex-col gap-2" aria-label="Courses">
                      {sem.courses.filter((c) => !c.archivedAt).map((c) => (
                        <CourseScope
                          key={c.id}
                          course={c}
                          inherited={wholeSemester === sem.id}
                          checked={courseIds.has(c.id)}
                          onToggle={() => toggleCourse(c.id)}
                          sectionIds={sectionIds}
                          onToggleSection={toggleSection}
                        />
                      ))}
                      {sem.courses.length === 0 && <li className="text-sm text-muted">No courses in this semester.</li>}
                    </ul>
                  </div>
                )}
              </>
            )}
          </Panel>

          {/* Mode */}
          <Panel className="p-5">
            <h2 className="mb-4 text-lg font-semibold">2. Mode</h2>
            <Segmented
              ariaLabel="Study mode"
              layout="cards"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'scheduled', label: 'Scheduled review', icon: <Play className="size-4" />, description: 'Due cards first, optionally new ones. Your first rating sets the next review date.' },
                { value: 'practice', label: 'Practice', icon: <Dumbbell className="size-4" />, description: 'Any cards, even if not due. Same repeats; your schedule stays unchanged.' },
                { value: 'test', label: 'Test once', icon: <ClipboardCheck className="size-4" />, description: 'One attempt per card. Optionally type an answer first. Schedule unchanged.' },
              ]}
            />
          </Panel>

          {/* Size & order */}
          <Panel className="p-5">
            <h2 className="mb-4 text-lg font-semibold">3. Size and order</h2>
            <div className="flex flex-col gap-5">
              <fieldset>
                <legend className="mb-1.5 text-sm font-medium text-text-2">Number of unique cards</legend>
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented
                    ariaLabel="Session size"
                    value={custom ? 'custom' : String(size)}
                    onChange={(v) => {
                      if (v === 'custom') setCustom(true);
                      else {
                        setCustom(false);
                        setSize(Number(v));
                      }
                    }}
                    options={[...SESSION_SIZE_PRESETS.map((n) => ({ value: String(n), label: String(n) })), { value: 'custom', label: 'Custom' }]}
                  />
                  {custom && (
                    <Input
                      type="number"
                      min={1}
                      max={1000}
                      aria-label="Custom number of cards"
                      className="no-spin w-24"
                      value={size || ''}
                      onChange={(e) => setSize(Math.min(1000, Math.max(0, Math.floor(Number(e.target.value) || 0))))}
                    />
                  )}
                </div>
                <p className="mt-1.5 text-[13px] text-muted">Counts unique cards, not attempts — difficult cards come back within the session.</p>
              </fieldset>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Order" htmlFor="sb-order">
                  <Select id="sb-order" value={ordering} onChange={(e) => setOrdering(e.target.value as SessionOrdering)}>
                    <option value="default">{mode === 'scheduled' ? 'Oldest due first, then new' : 'Course and section order'}</option>
                    <option value="random">Random (fixed for this session)</option>
                    <option value="weakest">Weakest first (by latest rating)</option>
                  </Select>
                </Field>
                <Field label="Max attempts per card" htmlFor="sb-max" hint={mode === 'test' ? 'Test mode always uses one attempt.' : 'Including the first. After this a card is marked “Needs another session”.'}>
                  <Input id="sb-max" type="number" min={1} max={10} disabled={mode === 'test'} value={mode === 'test' ? 1 : maxAttempts} onChange={(e) => setMaxAttempts(Math.min(10, Math.max(1, Math.floor(Number(e.target.value) || 1))))} />
                </Field>
              </div>
            </div>
          </Panel>

          {/* Filters */}
          <Panel className="p-5">
            <h2 className="mb-4 text-lg font-semibold">4. Filters</h2>
            <div className="flex flex-col gap-5">
              {mode === 'scheduled' ? (
                <Switch checked={filters.includeNew} onChange={(v) => setFilters({ ...filters, includeNew: v })} label="Include new cards" description="After all due cards, add never-reviewed cards up to the session size." />
              ) : (
                <Field label="Cards" htmlFor="sb-status">
                  <Select id="sb-status" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as SessionFilters['status'] })}>
                    <option value="any">All matching cards</option>
                    <option value="new">Only new (never scheduled)</option>
                    <option value="due">Only due</option>
                    <option value="notDue">Only not yet due</option>
                    <option value="weak">Only weak (latest rating Bad or Good)</option>
                    <option value="reviewed">Only cards rated before</option>
                  </Select>
                </Field>
              )}
              {(ordering === 'weakest' || filters.status === 'weak') && (
                <Field label="“Weak” is based on ratings from" htmlFor="sb-basis">
                  <Select id="sb-basis" value={filters.weakBasis} onChange={(e) => setFilters({ ...filters, weakBasis: e.target.value as SessionFilters['weakBasis'] })}>
                    <option value="all">All modes (scheduled, practice and test)</option>
                    <option value="scheduled">Scheduled reviews only</option>
                  </Select>
                </Field>
              )}
              <Checkbox checked={filters.bookmarkedOnly} onChange={(e) => setFilters({ ...filters, bookmarkedOnly: e.target.checked })} label="Only bookmarked cards" />
              {(tags.data?.length ?? 0) > 0 && (
                <fieldset>
                  <legend className="mb-1.5 text-sm font-medium text-text-2">Only cards with any of these tags</legend>
                  <div className="flex flex-wrap gap-1.5">
                    {tags.data!.map((t) => {
                      const on = filters.tags.includes(t.name);
                      return (
                        <button
                          key={t.name}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setFilters({ ...filters, tags: on ? filters.tags.filter((x) => x !== t.name) : [...filters.tags, t.name] })}
                          className={cn('rounded-full border px-3 py-1 text-sm transition-colors', on ? 'border-primary bg-primary-soft text-primary-text' : 'border-border text-text-2 hover:border-border-strong')}
                        >
                          #{t.name} <span className="text-muted">{t.count}</span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              )}
            </div>
          </Panel>
        </div>

        {/* Summary */}
        <aside className="min-w-0">
          <Panel className="sticky top-4 p-5">
            <h2 className="text-lg font-semibold">Summary</h2>
            {!hasScope ? (
              <p className="mt-3 text-muted">Select a semester, courses or sections to see what’s available.</p>
            ) : preview.error ? (
              <Alert className="mt-4" tone="danger" action={<Button size="sm" onClick={() => preview.refetch()}>Retry</Button>}>
                {errorMessage(preview.error)}
              </Alert>
            ) : !pv ? (
              <div className="mt-4 flex items-center gap-2 text-muted">
                <Spinner className="size-4" /> Checking cards…
              </div>
            ) : (
              <div className="mt-3 flex flex-col gap-4" aria-live="polite">
                <div>
                  <p className="text-sm text-muted">Scope</p>
                  <p className="font-medium">{pv.scopeLabel}</p>
                  {pv.scopeItems.length > 1 && (
                    <ul className="mt-1 text-sm text-text-2">
                      {pv.scopeItems.slice(0, 6).map((i) => (
                        <li key={i.id} className="truncate">
                          · {i.title}
                        </li>
                      ))}
                      {pv.scopeItems.length > 6 && <li className="text-muted">and {pv.scopeItems.length - 6} more</li>}
                    </ul>
                  )}
                </div>
                <dl className="grid grid-cols-3 gap-2 rounded-xl bg-surface-2 p-3 text-center">
                  <div>
                    <dt className="text-xs text-muted">Due</dt>
                    <dd className="text-lg font-semibold tabular-nums">{pv.breakdown.due}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">New</dt>
                    <dd className="text-lg font-semibold tabular-nums">{pv.breakdown.new}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Not yet due</dt>
                    <dd className="text-lg font-semibold tabular-nums">{pv.breakdown.notYetDue}</dd>
                  </div>
                </dl>
                <ul className="flex flex-col gap-1 text-sm text-text-2">
                  <li className="flex justify-between">
                    <span>Weak (latest Bad/Good)</span>
                    <span className="tabular-nums">{pv.breakdown.weak}</span>
                  </li>
                  <li className="flex justify-between">
                    <span>Never rated</span>
                    <span className="tabular-nums">{pv.breakdown.neverReviewed}</span>
                  </li>
                  {pv.breakdown.suspended > 0 && (
                    <li className="flex justify-between text-muted">
                      <span>Suspended (excluded)</span>
                      <span className="tabular-nums">{pv.breakdown.suspended}</span>
                    </li>
                  )}
                </ul>
                <div className="border-t border-border pt-4">
                  <p className="text-[15px]">
                    <strong className="font-semibold">{plural(pv.available, 'card')} available</strong> for this mode
                  </p>
                  {pv.willSelect > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {pv.selection.due > 0 && <Badge tone="danger">{pv.selection.due} due</Badge>}
                      {pv.selection.new > 0 && <Badge tone="primary">{pv.selection.new} new</Badge>}
                      {pv.selection.notYetDue > 0 && <Badge>{pv.selection.notYetDue} not yet due</Badge>}
                    </div>
                  )}
                </div>
                {error && <Alert tone="danger">{error}</Alert>}
                {available === 0 ? (
                  <Alert tone="warning" title="Nothing to study with these settings">
                    {mode === 'scheduled' ? (filters.includeNew ? 'No cards are due or new here. Try Practice mode to go over any cards.' : 'No cards are due. Turn on “Include new cards” or use Practice mode.') : 'No cards match. Widen the scope or relax the filters.'}
                  </Alert>
                ) : smaller ? (
                  <>
                    <Alert tone="info" title={`${plural(available, 'card')} available`}>
                      You asked for {request.size}. The session will contain {available} unique cards — cards are never duplicated to fill it.
                    </Alert>
                    <Button variant="primary" size="lg" loading={starting} onClick={() => start(true)} disabled={!!open.data} icon={<Play className="size-4 fill-current" />}>
                      Start with {available}
                    </Button>
                  </>
                ) : (
                  <Button variant="primary" size="lg" loading={starting} onClick={() => start(false)} disabled={!!open.data || preview.isFetching} icon={<Play className="size-4 fill-current" />}>
                    Start session · {plural(pv.willSelect, 'card')}
                  </Button>
                )}
              </div>
            )}
          </Panel>
        </aside>
      </div>

      <ConfirmDialog
        open={endOpen}
        onOpenChange={setEndOpen}
        title="End the open session?"
        tone="danger"
        confirmLabel="End session"
        onConfirm={async () => {
          try {
            await api.post(`/api/sessions/${open.data!.id}/end`);
            invalidateContent();
            toast.success('Session ended. Ratings you already gave are kept.');
            setError(null);
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      >
        Ratings already given stay saved (including schedule updates). Cards you haven’t reached stay as they are.
      </ConfirmDialog>
    </>
  );
}

function CourseScope({
  course: c,
  inherited,
  checked,
  onToggle,
  sectionIds,
  onToggleSection,
}: {
  course: TreeProgram['semesters'][number]['courses'][number];
  inherited: boolean;
  checked: boolean;
  onToggle: () => void;
  sectionIds: Set<string>;
  onToggleSection: (id: string) => void;
}) {
  const sections = c.sections.filter((s) => !s.archivedAt);
  const anySection = sections.some((s) => sectionIds.has(s.id));
  const [expanded, setExpanded] = useState(anySection);
  const whole = inherited || checked;
  return (
    <li style={courseVars(c.color)} className={cn('rounded-xl border px-3 py-2.5', whole || anySection ? 'border-primary/50 bg-primary-soft/40' : 'border-border')}>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={`sc-${c.id}`}
          className="size-[18px] shrink-0 accent-[var(--primary)]"
          checked={whole}
          disabled={inherited}
          onChange={onToggle}
        />
        <span className="size-2.5 shrink-0 rounded-[3px] bg-[var(--course)]" aria-hidden />
        <label htmlFor={`sc-${c.id}`} className="min-w-0 flex-1 cursor-pointer">
          <span className="block truncate font-medium">{c.title}</span>
          <span className="block text-[13px] text-muted">
            {c.counts.due} due · {c.counts.new} new · {plural(c.counts.total, 'card')}
          </span>
        </label>
        {sections.length > 0 && (
          <button className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-muted hover:bg-surface-2 hover:text-text" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {anySection && !whole ? `${sections.filter((s) => sectionIds.has(s.id)).length} selected` : 'Sections'}
            <ChevronRight className={cn('size-4 transition-transform duration-150', expanded && 'rotate-90')} aria-hidden />
          </button>
        )}
      </div>
      {expanded && (
        <ul className="mt-2 ml-7 flex flex-col gap-1.5 border-l border-border pl-3">
          {sections.map((s) => (
            <li key={s.id}>
              <Checkbox
                checked={whole || sectionIds.has(s.id)}
                disabled={whole}
                onChange={() => onToggleSection(s.id)}
                label={s.title}
                description={`${s.counts.due} due · ${s.counts.new} new · ${plural(s.counts.total, 'card')}`}
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
