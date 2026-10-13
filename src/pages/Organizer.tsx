import { Archive, ArchiveRestore, ArrowDown, ArrowUp, CalendarCheck, Copy, FolderInput, GraduationCap, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { Level, TreeCourse, TreeProgram, TreeSemester } from '../../shared/types.ts';
import { CourseIcon } from '../components/CourseIcon.tsx';
import { useHierarchy } from '../components/HierarchyDialogs.tsx';
import { PageHeader } from '../components/layout/AppShell.tsx';
import { Button, IconButton } from '../components/ui/Button.tsx';
import { Badge, EmptyState, ErrorState, PageLoader, Panel } from '../components/ui/Feedback.tsx';
import { Segmented } from '../components/ui/Form.tsx';
import { Menu } from '../components/ui/Menu.tsx';
import { useToast } from '../components/ui/Toast.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { formatDate, plural } from '../lib/format.ts';
import { invalidateContent, queryClient, useDashboard, useTree } from '../lib/queries.ts';

export function Organizer() {
  const [view, setView] = useState<'active' | 'archived'>('active');
  const tree = useTree(view === 'archived');
  const h = useHierarchy();
  return (
    <>
      <PageHeader
        title="Organize"
        subtitle="Study programs, semesters and courses. Archived items keep their progress but are hidden from study."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => h.create('program')}>
            New study program
          </Button>
        }
      />
      <Segmented
        ariaLabel="Show"
        value={view}
        onChange={setView}
        className="mb-6"
        options={[
          { value: 'active', label: 'Active' },
          { value: 'archived', label: 'Archived' },
        ]}
      />
      {tree.isLoading ? <PageLoader /> : tree.error ? <ErrorState error={tree.error} onRetry={() => tree.refetch()} /> : view === 'active' ? <ActiveTree programs={tree.data!} /> : <ArchivedList programs={tree.data!} />}
    </>
  );
}

function useReorder() {
  const toast = useToast();
  return async (level: Level, parentId: string | null, ids: string[], index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    const next = ids.slice();
    [next[index], next[j]] = [next[j], next[index]];
    try {
      await api.post(`/api/${level}s/reorder`, { parentId, ids: next });
      invalidateContent();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
}

function useArchive() {
  const toast = useToast();
  return async (level: Level, id: string, archived: boolean, title: string) => {
    try {
      await api.patch(`/api/${level}s/${id}`, { archived });
      invalidateContent();
      toast.success(archived ? `Archived “${title}”` : `Restored “${title}” from the archive`, archived ? { label: 'Undo', onClick: () => void api.patch(`/api/${level}s/${id}`, { archived: false }).then(invalidateContent) } : undefined);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
}

function MoveButtons({ onUp, onDown, first, last, label }: { onUp: () => void; onDown: () => void; first: boolean; last: boolean; label: string }) {
  return (
    <span className="flex">
      <IconButton size="sm" label={`Move ${label} up`} onClick={onUp} disabled={first}>
        <ArrowUp className="size-4" />
      </IconButton>
      <IconButton size="sm" label={`Move ${label} down`} onClick={onDown} disabled={last}>
        <ArrowDown className="size-4" />
      </IconButton>
    </span>
  );
}

function ActiveTree({ programs }: { programs: TreeProgram[] }) {
  const h = useHierarchy();
  const reorder = useReorder();
  const archive = useArchive();
  const dash = useDashboard();
  const currentSem = dash.data?.currentSemester?.id;
  if (!programs.length) {
    return (
      <EmptyState icon={<GraduationCap className="size-6" />} title="No study programs yet" action={<Button variant="primary" onClick={() => h.create('program')}>New study program</Button>}>
        A program can be a degree like “M.Sc. Informatics” or a personal learning collection.
      </EmptyState>
    );
  }
  const pIds = programs.map((p) => p.id);
  return (
    <div className="flex flex-col gap-6">
      {programs.map((p, pi) => (
        <Panel key={p.id} id={p.id} className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-2/60 px-5 py-4">
            <GraduationCap className="size-5 text-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-lg font-semibold">{p.title}</h2>
              {p.description && <p className="line-clamp-1 text-sm text-muted">{p.description}</p>}
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => h.create('semester', p.id)}>
                Semester
              </Button>
              <MoveButtons label={p.title} first={pi === 0} last={pi === programs.length - 1} onUp={() => reorder('program', null, pIds, pi, -1)} onDown={() => reorder('program', null, pIds, pi, 1)} />
              <Menu
                label={`Actions for ${p.title}`}
                items={[
                  { label: 'Edit program', icon: <Pencil />, onSelect: () => h.edit('program', p) },
                  { label: 'Archive', icon: <Archive />, onSelect: () => archive('program', p.id, true, p.title) },
                  { label: 'Move to trash', icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: () => h.remove('program', p.id, p.title) },
                ]}
              />
            </div>
          </div>
          {p.semesters.length === 0 ? (
            <p className="px-5 py-6 text-muted">No semesters yet. Add one to start organizing courses.</p>
          ) : (
            <ul className="divide-y divide-border">
              {p.semesters.map((s, si) => (
                <SemesterRow key={s.id} s={s} index={si} siblings={p.semesters} programId={p.id} current={s.id === currentSem} />
              ))}
            </ul>
          )}
        </Panel>
      ))}
    </div>
  );
}

function SemesterRow({ s, index, siblings, programId, current }: { s: TreeSemester; index: number; siblings: TreeSemester[]; programId: string; current: boolean }) {
  const h = useHierarchy();
  const reorder = useReorder();
  const archive = useArchive();
  const toast = useToast();
  const ids = siblings.map((x) => x.id);
  const cIds = s.courses.map((c) => c.id);
  return (
    <li id={s.id} className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2 font-semibold">
            {s.title}
            {current && <Badge tone="primary">Current</Badge>}
          </h3>
          <p className="text-sm text-muted">
            {s.startDate || s.endDate ? `${formatDate(s.startDate) || '…'} – ${formatDate(s.endDate) || '…'} · ` : ''}
            {plural(s.courses.length, 'course')} · {plural(s.counts.total, 'card')}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => h.create('course', s.id)}>
            Course
          </Button>
          <MoveButtons label={s.title} first={index === 0} last={index === siblings.length - 1} onUp={() => reorder('semester', programId, ids, index, -1)} onDown={() => reorder('semester', programId, ids, index, 1)} />
          <Menu
            label={`Actions for ${s.title}`}
            items={[
              !current && {
                label: 'Set as current semester',
                icon: <CalendarCheck />,
                onSelect: async () => {
                  try {
                    await api.patch('/api/settings', { currentSemesterId: s.id });
                    queryClient.invalidateQueries({ queryKey: ['settings'] });
                    invalidateContent();
                    toast.success(`${s.title} is now the current semester`);
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                },
              },
              { label: 'Edit semester', icon: <Pencil />, onSelect: () => h.edit('semester', s) },
              { label: 'Archive', icon: <Archive />, onSelect: () => archive('semester', s.id, true, s.title) },
              { label: 'Move to trash', icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: () => h.remove('semester', s.id, s.title) },
            ]}
          />
        </div>
      </div>
      {s.courses.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {s.courses.map((c, ci) => (
            <CourseRow key={c.id} c={c} index={ci} count={s.courses.length} onUp={() => reorder('course', s.id, cIds, ci, -1)} onDown={() => reorder('course', s.id, cIds, ci, 1)} />
          ))}
        </ul>
      )}
    </li>
  );
}

function CourseRow({ c, index, count, onUp, onDown }: { c: TreeCourse; index: number; count: number; onUp: () => void; onDown: () => void }) {
  const h = useHierarchy();
  const archive = useArchive();
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2">
      <CourseIcon icon={c.icon} color={c.color} size="sm" />
      <Link to={`/courses/${c.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
        {c.title}
        {c.moduleCode && <span className="ml-2 text-sm font-normal text-muted">{c.moduleCode}</span>}
      </Link>
      <span className="hidden text-sm text-muted tabular-nums sm:inline">
        {plural(c.sections.length, 'section')} · {plural(c.counts.total, 'card')}
      </span>
      <MoveButtons label={c.title} first={index === 0} last={index === count - 1} onUp={onUp} onDown={onDown} />
      <Menu
        label={`Actions for ${c.title}`}
        items={[
          { label: 'Edit course', icon: <Pencil />, onSelect: () => h.edit('course', c) },
          { label: 'Duplicate to semester…', icon: <Copy />, onSelect: () => h.duplicateCourse(c) },
          { label: 'Move to semester…', icon: <FolderInput />, onSelect: () => h.moveCourse(c) },
          { label: 'Archive', icon: <Archive />, onSelect: () => archive('course', c.id, true, c.title) },
          { label: 'Move to trash', icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: () => h.remove('course', c.id, c.title) },
        ]}
      />
    </li>
  );
}

function ArchivedList({ programs }: { programs: TreeProgram[] }) {
  const archive = useArchive();
  const items: { level: Level; id: string; title: string; context: string; archivedAt: string }[] = [];
  for (const p of programs) {
    if (p.archivedAt) items.push({ level: 'program', id: p.id, title: p.title, context: 'Study program', archivedAt: p.archivedAt });
    for (const s of p.semesters) {
      if (s.archivedAt) items.push({ level: 'semester', id: s.id, title: s.title, context: p.title, archivedAt: s.archivedAt });
      for (const c of s.courses) {
        if (c.archivedAt) items.push({ level: 'course', id: c.id, title: c.title, context: `${p.title} › ${s.title}`, archivedAt: c.archivedAt });
        for (const sec of c.sections) if (sec.archivedAt) items.push({ level: 'section', id: sec.id, title: sec.title, context: `${s.title} › ${c.title}`, archivedAt: sec.archivedAt });
      }
    }
  }
  if (!items.length) {
    return (
      <EmptyState icon={<Archive className="size-6" />} title="Nothing archived">
        Archive finished semesters or courses to hide them from study without losing their history.
      </EmptyState>
    );
  }
  return (
    <Panel as="div" className="divide-y divide-border">
      {items.map((it) => (
        <div key={it.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {it.level === 'course' ? <Link to={`/courses/${it.id}`} className="hover:underline">{it.title}</Link> : it.level === 'section' ? <Link to={`/sections/${it.id}`} className="hover:underline">{it.title}</Link> : it.title}
            </p>
            <p className="text-sm text-muted">
              {it.level.charAt(0).toUpperCase() + it.level.slice(1)} · {it.context} · archived {formatDate(it.archivedAt.slice(0, 10))}
            </p>
          </div>
          <Button size="sm" icon={<ArchiveRestore className="size-4" />} onClick={() => archive(it.level, it.id, false, it.title)}>
            Unarchive
          </Button>
        </div>
      ))}
    </Panel>
  );
}
