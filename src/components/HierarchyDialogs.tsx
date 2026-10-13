import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { COURSE_COLORS, COURSE_ICONS, SECTION_KINDS } from '../../shared/catalog.ts';
import type { Course, ImpactCounts, Level, Program, Section, Semester, TrashType } from '../../shared/types.ts';
import { api, errorMessage } from '../lib/api.ts';
import { plural } from '../lib/format.ts';
import { invalidateContent, queryClient, useTree } from '../lib/queries.ts';
import { cn, COURSE_HEX } from '../lib/util.ts';
import { CourseIcon, ICONS } from './CourseIcon.tsx';
import { Button } from './ui/Button.tsx';
import { Alert, Spinner } from './ui/Feedback.tsx';
import { Checkbox, Field, Input, Select, Textarea } from './ui/Form.tsx';
import { Modal } from './ui/Dialog.tsx';
import { useToast } from './ui/Toast.tsx';

type AnyItem = Program | Semester | Course | Section;

type DialogState =
  | { kind: 'create'; level: Level; parentId?: string }
  | { kind: 'edit'; level: Level; item: AnyItem }
  | { kind: 'delete'; type: TrashType; id: string; title: string; after?: () => void }
  | { kind: 'moveSection'; section: Section }
  | { kind: 'moveCourse'; course: Course }
  | { kind: 'duplicateCourse'; course: Course }
  | null;

interface HierarchyApi {
  create: (level: Level, parentId?: string) => void;
  edit: (level: Level, item: AnyItem) => void;
  remove: (type: TrashType, id: string, title: string, after?: () => void) => void;
  moveSection: (section: Section) => void;
  moveCourse: (course: Course) => void;
  duplicateCourse: (course: Course) => void;
}

const Ctx = createContext<HierarchyApi | null>(null);

export function useHierarchy(): HierarchyApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useHierarchy outside provider');
  return c;
}

export const LEVEL_LABEL: Record<Level, string> = {
  program: 'study program',
  semester: 'semester',
  course: 'course',
  section: 'section',
};

export function HierarchyDialogs({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>(null);
  const api_ = useMemo<HierarchyApi>(
    () => ({
      create: (level, parentId) => setState({ kind: 'create', level, parentId }),
      edit: (level, item) => setState({ kind: 'edit', level, item }),
      remove: (type, id, title, after) => setState({ kind: 'delete', type, id, title, after }),
      moveSection: (section) => setState({ kind: 'moveSection', section }),
      moveCourse: (course) => setState({ kind: 'moveCourse', course }),
      duplicateCourse: (course) => setState({ kind: 'duplicateCourse', course }),
    }),
    [],
  );
  const close = () => setState(null);
  return (
    <Ctx.Provider value={api_}>
      {children}
      {state && (state.kind === 'create' || state.kind === 'edit') && <ItemDialog state={state} onClose={close} />}
      {state?.kind === 'delete' && <DeleteDialog {...state} onClose={close} />}
      {state?.kind === 'moveSection' && <MoveSectionDialog section={state.section} onClose={close} />}
      {state?.kind === 'moveCourse' && <MoveCourseDialog course={state.course} onClose={close} />}
      {state?.kind === 'duplicateCourse' && <DuplicateCourseDialog course={state.course} onClose={close} />}
    </Ctx.Provider>
  );
}

// ---------------- Create / edit ----------------

function ItemDialog({ state, onClose }: { state: { kind: 'create'; level: Level; parentId?: string } | { kind: 'edit'; level: Level; item: AnyItem }; onClose: () => void }) {
  const { level } = state;
  const editing = state.kind === 'edit' ? (state.item as AnyItem & Record<string, unknown>) : null;
  const tree = useTree();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [v, setV] = useState<Record<string, string | number | null>>(() => ({
    title: (editing?.title as string) ?? '',
    description: (editing?.description as string) ?? '',
    startDate: (editing?.startDate as string) ?? '',
    endDate: (editing?.endDate as string) ?? '',
    moduleCode: (editing?.moduleCode as string) ?? '',
    color: (editing?.color as string) ?? 'indigo',
    icon: (editing?.icon as string) ?? 'book-open',
    examDate: (editing?.examDate as string) ?? '',
    kind: (editing?.kind as string) ?? 'lecture',
    weekNumber: (editing?.weekNumber as number | null) ?? '',
    date: (editing?.date as string) ?? '',
    notes: (editing?.notes as string) ?? '',
    parentId: state.kind === 'create' ? (state.parentId ?? '') : '',
  }));
  const set = (k: string, val: string | number | null) => setV((p) => ({ ...p, [k]: val }));

  // Parent options for create.
  const parents = useMemo(() => {
    const t = tree.data ?? [];
    if (level === 'semester') return t.map((p) => ({ id: p.id, label: p.title }));
    if (level === 'course') return t.flatMap((p) => p.semesters.map((s) => ({ id: s.id, label: `${p.title} › ${s.title}` })));
    if (level === 'section') return t.flatMap((p) => p.semesters.flatMap((s) => s.courses.map((c) => ({ id: c.id, label: `${s.title} › ${c.title}` }))));
    return [];
  }, [tree.data, level]);
  useEffect(() => {
    if (state.kind === 'create' && level !== 'program' && !v.parentId && parents.length) set('parentId', parents[0].id);
  }, [parents]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!String(v.title).trim()) {
      setError('Please enter a title.');
      return;
    }
    const body: Record<string, unknown> = { title: String(v.title).trim() };
    if (level === 'program') body.description = v.description;
    if (level === 'semester') Object.assign(body, { startDate: v.startDate || null, endDate: v.endDate || null });
    if (level === 'course') Object.assign(body, { moduleCode: v.moduleCode, color: v.color, icon: v.icon, description: v.description, examDate: v.examDate || null });
    if (level === 'section')
      Object.assign(body, { kind: v.kind, weekNumber: v.weekNumber === '' || v.weekNumber === null ? null : Number(v.weekNumber), date: v.date || null, notes: v.notes });
    if (state.kind === 'create' && level !== 'program') {
      if (!v.parentId) {
        setError(`Create a ${LEVEL_LABEL[level === 'semester' ? 'program' : level === 'course' ? 'semester' : 'course']} first.`);
        return;
      }
      body[`${level === 'semester' ? 'program' : level === 'course' ? 'semester' : 'course'}Id`] = v.parentId;
    }
    setBusy(true);
    try {
      if (state.kind === 'create') {
        const created = await api.post<AnyItem>(`/api/${level}s`, body);
        toast.success(`Created ${LEVEL_LABEL[level]} “${created.title}”`);
        invalidateContent();
        onClose();
        if (level === 'course') navigate(`/courses/${created.id}`);
        if (level === 'section') navigate(`/sections/${created.id}`);
      } else {
        await api.patch(`/api/${level}s/${state.item.id}`, body);
        toast.success('Saved');
        invalidateContent();
        queryClient.invalidateQueries({ queryKey: [level] });
        onClose();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const title = `${state.kind === 'create' ? 'New' : 'Edit'} ${LEVEL_LABEL[level]}`;
  const placeholders: Record<Level, string> = {
    program: 'e.g. M.Sc. Informatics',
    semester: 'e.g. Winter semester 2026/27',
    course: 'e.g. Computer Vision III',
    section: 'e.g. Week 03 — Object detection',
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      size={level === 'course' ? 'lg' : 'md'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="item-form" loading={busy}>
            {state.kind === 'create' ? `Create ${LEVEL_LABEL[level]}` : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id="item-form" onSubmit={submit} className="flex flex-col gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {state.kind === 'create' && level !== 'program' && (
          <Field label={level === 'semester' ? 'Study program' : level === 'course' ? 'Semester' : 'Course'} htmlFor="f-parent">
            {parents.length ? (
              <Select id="f-parent" value={String(v.parentId)} onChange={(e) => set('parentId', e.target.value)}>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-sm text-muted">Nothing to add this to yet — create the level above first.</p>
            )}
          </Field>
        )}
        <Field label="Title" htmlFor="f-title">
          <Input id="f-title" autoFocus value={String(v.title)} onChange={(e) => set('title', e.target.value)} placeholder={placeholders[level]} maxLength={200} required />
        </Field>

        {level === 'semester' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Start date" optional htmlFor="f-start">
              <Input id="f-start" type="date" value={String(v.startDate)} onChange={(e) => set('startDate', e.target.value)} />
            </Field>
            <Field label="End date" optional htmlFor="f-end">
              <Input id="f-end" type="date" value={String(v.endDate)} onChange={(e) => set('endDate', e.target.value)} />
            </Field>
          </div>
        )}

        {level === 'course' && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Module code" optional htmlFor="f-code">
                <Input id="f-code" value={String(v.moduleCode)} onChange={(e) => set('moduleCode', e.target.value)} placeholder="e.g. IN2375" maxLength={60} />
              </Field>
              <Field label="Exam date" optional htmlFor="f-exam">
                <Input id="f-exam" type="date" value={String(v.examDate)} onChange={(e) => set('examDate', e.target.value)} />
              </Field>
            </div>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-text-2">Colour</legend>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Course colour">
                {COURSE_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={v.color === c}
                    aria-label={c}
                    onClick={() => set('color', c)}
                    className={cn('flex size-8 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition', v.color === c && 'ring-2 ring-text')}
                    style={{ background: COURSE_HEX[c] }}
                  >
                    {v.color === c && <Check className="size-4 text-white" />}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-text-2">Icon</legend>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Course icon">
                {COURSE_ICONS.map((ic) => {
                  const Icon = ICONS[ic];
                  return (
                    <button
                      key={ic}
                      type="button"
                      role="radio"
                      aria-checked={v.icon === ic}
                      aria-label={ic}
                      onClick={() => set('icon', ic)}
                      className={cn('flex size-10 items-center justify-center rounded-xl border transition', v.icon === ic ? 'border-primary bg-primary-soft text-primary-text' : 'border-border text-muted hover:border-border-strong hover:text-text')}
                    >
                      <Icon className="size-5" />
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <Field label="Description" optional htmlFor="f-desc">
              <Textarea id="f-desc" value={String(v.description)} onChange={(e) => set('description', e.target.value)} rows={3} />
            </Field>
            <div className="flex items-center gap-3 rounded-xl bg-surface-2 p-3 text-sm">
              <CourseIcon icon={String(v.icon)} color={String(v.color)} />
              <span className="font-medium">{String(v.title) || 'Course preview'}</span>
            </div>
          </>
        )}

        {level === 'section' && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Type" htmlFor="f-kind">
                <Select id="f-kind" value={String(v.kind)} onChange={(e) => set('kind', e.target.value)}>
                  {SECTION_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Week" optional htmlFor="f-week">
                <Input id="f-week" type="number" min={0} max={999} value={v.weekNumber === null ? '' : String(v.weekNumber)} onChange={(e) => set('weekNumber', e.target.value)} />
              </Field>
              <Field label="Date" optional htmlFor="f-date">
                <Input id="f-date" type="date" value={String(v.date)} onChange={(e) => set('date', e.target.value)} />
              </Field>
            </div>
            <Field label="Notes" optional htmlFor="f-notes">
              <Textarea id="f-notes" value={String(v.notes)} onChange={(e) => set('notes', e.target.value)} rows={3} placeholder="Reading list, slide link reference, what to focus on…" />
            </Field>
          </>
        )}

        {level === 'program' && (
          <Field label="Description" optional htmlFor="f-desc">
            <Textarea id="f-desc" value={String(v.description)} onChange={(e) => set('description', e.target.value)} rows={3} />
          </Field>
        )}
      </form>
    </Modal>
  );
}

// ---------------- Delete (to trash) ----------------

function DeleteDialog({ type, id, title, after, onClose }: { type: TrashType; id: string; title: string; after?: () => void; onClose: () => void }) {
  const toast = useToast();
  const impact = useQuery({ queryKey: ['impact', type, id], queryFn: () => api.get<ImpactCounts>(`/api/impact/${type}/${id}`), staleTime: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = type === 'card' ? 'card' : LEVEL_LABEL[type];
  const i = impact.data;
  const lines = i
    ? [
        i.semesters ? plural(i.semesters, 'semester') : null,
        i.courses ? plural(i.courses, 'course') : null,
        i.sections ? plural(i.sections, 'section') : null,
        type !== 'card' ? plural(i.cards, 'card') : null,
        i.reviews ? plural(i.reviews, 'recorded review') : null,
      ].filter(Boolean)
    : [];
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/items/${type}/${id}`);
      invalidateContent();
      onClose();
      after?.();
      toast.success(`Moved “${title.slice(0, 60)}” to the trash`, {
        label: 'Undo',
        onClick: async () => {
          try {
            await api.post('/api/trash/restore', { type, id });
            invalidateContent();
            toast.success('Restored');
          } catch (e) {
            toast.error(errorMessage(e));
          }
        },
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Move this ${label} to the trash?`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={confirm} loading={busy} disabled={!i || i.openSessionCards > 0}>
            Move to trash
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[15px]">
        <p>
          <strong className="font-semibold">“{title}”</strong>
          {type !== 'card' && ' and everything inside it'} will be hidden everywhere, including study sessions.
        </p>
        {impact.isLoading && <Spinner />}
        {lines.length > 0 && (
          <div className="rounded-xl bg-surface-2 px-4 py-3 text-sm">
            <p className="font-medium">Affected</p>
            <ul className="mt-1 list-disc pl-5 text-text-2">
              {lines.map((l) => (
                <li key={l as string}>{l}</li>
              ))}
            </ul>
          </div>
        )}
        {i && i.openSessionCards > 0 && (
          <Alert tone="warning" title="Used by your open study session">
            Finish or end that session first, so it cannot lose cards mid-way.
          </Alert>
        )}
        <p className="text-sm text-muted">Nothing is lost yet: you can restore it from the trash, where permanent deletion needs a second confirmation.</p>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

// ---------------- Move / duplicate ----------------

function MoveSectionDialog({ section, onClose }: { section: Section; onClose: () => void }) {
  const tree = useTree();
  const toast = useToast();
  const options = (tree.data ?? []).flatMap((p) => p.semesters.flatMap((s) => s.courses.map((c) => ({ id: c.id, label: `${s.title} › ${c.title}`, sem: s.title }))));
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = options.filter((o) => o.id !== section.courseId);
  const dest = candidates.find((c) => c.id === (target || candidates[0]?.id));
  const submit = async () => {
    if (!dest) return;
    setBusy(true);
    try {
      await api.post(`/api/sections/${section.id}/move`, { courseId: dest.id });
      invalidateContent();
      queryClient.invalidateQueries({ queryKey: ['section', section.id] });
      toast.success(`Moved to ${dest.label}`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Move section to another course"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!dest}>
            Move section
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {candidates.length ? (
          <Field label="Destination course" htmlFor="mv-course">
            <Select id="mv-course" value={dest?.id ?? ''} onChange={(e) => setTarget(e.target.value)}>
              {candidates.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="text-muted">There is no other course to move this section to yet.</p>
        )}
        {dest && (
          <Alert tone="info" title="Please confirm">
            “{section.title}” and all its cards will move to <strong>{dest.label}</strong>. Card schedules and review history are kept.
          </Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

function SemesterSelect({ id, value, onChange, exclude }: { id: string; value: string; onChange: (v: string) => void; exclude?: string }) {
  const tree = useTree();
  const options = (tree.data ?? []).flatMap((p) => p.semesters.filter((s) => s.id !== exclude).map((s) => ({ id: s.id, label: `${p.title} › ${s.title}` })));
  useEffect(() => {
    if (!value && options.length) onChange(options[0].id);
  }, [options.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!options.length) return <p className="text-sm text-muted">Create another semester first.</p>;
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

function MoveCourseDialog({ course, onClose }: { course: Course; onClose: () => void }) {
  const toast = useToast();
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Move course to another semester"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!target}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post(`/api/courses/${course.id}/move`, { semesterId: target });
                invalidateContent();
                toast.success('Course moved');
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Move course
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Destination semester" htmlFor="mvc-sem">
          <SemesterSelect id="mvc-sem" value={target} onChange={setTarget} exclude={course.semesterId} />
        </Field>
        <p className="text-sm text-muted">The course keeps its sections, cards and full study history.</p>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

function DuplicateCourseDialog({ course, onClose }: { course: Course; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [target, setTarget] = useState(course.semesterId);
  const [title, setTitle] = useState(course.title);
  const [copyProgress, setCopyProgress] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Duplicate course"
      description="Creates an independent copy with new IDs — for example to reuse a course in a later semester."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const c = await api.post<Course>(`/api/courses/${course.id}/duplicate`, { semesterId: target, title, copyProgress });
                invalidateContent();
                toast.success('Course duplicated');
                onClose();
                navigate(`/courses/${c.id}`);
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Duplicate
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Into semester" htmlFor="dup-sem">
          <SemesterSelect id="dup-sem" value={target} onChange={setTarget} />
        </Field>
        <Field label="Title of the copy" htmlFor="dup-title">
          <Input id="dup-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Checkbox
          checked={copyProgress}
          onChange={(e) => setCopyProgress(e.target.checked)}
          label="Copy scheduling progress"
          description="Off by default: the copy starts with all cards new. Review history is never copied."
        />
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}
