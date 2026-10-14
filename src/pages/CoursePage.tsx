import { Archive, ArchiveRestore, ArrowDown, ArrowUp, CalendarClock, Copy, Download, FileDown, FileUp, FolderInput, Layers, Pencil, Play, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { SECTION_KINDS } from '../../shared/catalog.ts';
import { diffDays } from '../../shared/dates.ts';
import type { TreeSection } from '../../shared/types.ts';
import { CardRowCompact } from '../components/CardList.tsx';
import { CourseIcon } from '../components/CourseIcon.tsx';
import { CsvImportDialog } from '../components/CsvImport.tsx';
import { useHierarchy } from '../components/HierarchyDialogs.tsx';
import { Breadcrumbs, PageHeader, SectionTitle } from '../components/layout/AppShell.tsx';
import { Button, IconButton, LinkButton } from '../components/ui/Button.tsx';
import { Alert, Badge, EmptyState, ErrorState, PageLoader, Panel, Stat } from '../components/ui/Feedback.tsx';
import { Checkbox, Input } from '../components/ui/Form.tsx';
import { Menu } from '../components/ui/Menu.tsx';
import { useToast } from '../components/ui/Toast.tsx';
import { api, downloadUrl, errorMessage, qs } from '../lib/api.ts';
import { formatDate, plural } from '../lib/format.ts';
import { invalidateContent, useCards, useCourse, useDashboard, useTree } from '../lib/queries.ts';
import { cn, courseVars, useDebounced } from '../lib/util.ts';

export function CoursePage() {
  const { id } = useParams();
  const course = useCourse(id);
  const tree = useTree(true);
  const dash = useDashboard();
  const h = useHierarchy();
  const toast = useToast();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [csv, setCsv] = useState(false);
  const q = useDebounced(query.trim(), 250);
  const cardHits = useCards({ courseId: id, q, limit: 30 }, q.length > 0);

  const treeCourse = useMemo(() => {
    for (const p of tree.data ?? []) for (const s of p.semesters) for (const c of s.courses) if (c.id === id) return c;
    return null;
  }, [tree.data, id]);

  if (course.isLoading || tree.isLoading) return <PageLoader />;
  if (course.error) return <ErrorState error={course.error} onRetry={() => course.refetch()} />;
  const c = course.data!.item;
  const st = course.data!.state;
  const allSections = treeCourse?.sections ?? [];
  const visible = allSections.filter((s) => (showArchived || !s.archivedAt) && (!q || s.title.toLowerCase().includes(q.toLowerCase()) || s.notes.toLowerCase().includes(q.toLowerCase())));
  const active = allSections.filter((s) => !s.archivedAt);
  const counts = treeCourse?.counts ?? { total: 0, due: 0, new: 0, suspended: 0 };
  const today = dash.data?.today;
  const daysToExam = c.examDate && today ? diffDays(today, c.examDate) : null;
  const activeIds = active.map((s) => s.id);

  const reorder = async (sectionId: string, dir: -1 | 1) => {
    const visibleIndex = visible.findIndex((s) => s.id === sectionId);
    const neighbour = visible[visibleIndex + dir];
    if (!neighbour) return;
    const ids = allSections.map((s) => s.id);
    const index = ids.indexOf(sectionId);
    const neighbourIndex = ids.indexOf(neighbour.id);
    [ids[index], ids[neighbourIndex]] = [ids[neighbourIndex], ids[index]];
    try {
      await api.post('/api/sections/reorder', { parentId: c.id, ids });
      invalidateContent();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const setArchived = async (archived: boolean, level: 'course' | 'section', itemId: string, title: string) => {
    try {
      await api.patch(`/api/${level}s/${itemId}`, { archived });
      invalidateContent();
      toast.success(archived ? `Archived “${title}”` : `Unarchived “${title}”`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const toggle = (sid: string) => {
    const next = new Set(selected);
    if (next.has(sid)) next.delete(sid);
    else next.add(sid);
    setSelected(next);
  };
  const studySelected = () => navigate(`/study/new${qs({ sections: [...selected].join(',') })}`);
  const firstSection = active[0];

  return (
    <div style={courseVars(c.color)}>
      <PageHeader
        crumbs={<Breadcrumbs crumbs={course.data!.breadcrumbs} />}
        icon={<CourseIcon icon={c.icon} color={c.color} size="lg" />}
        title={c.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {c.moduleCode && <span className="font-medium text-text-2">{c.moduleCode}</span>}
            {c.examDate && (
              <span className={cn('inline-flex items-center gap-1.5', daysToExam !== null && daysToExam >= 0 && daysToExam <= 14 && 'font-medium text-warning')}>
                <CalendarClock className="size-4" aria-hidden />
                Exam {formatDate(c.examDate)}
                {daysToExam !== null && daysToExam >= 0 && ` · ${daysToExam === 0 ? 'today' : `in ${plural(daysToExam, 'day')}`}`}
              </span>
            )}
            {st.inArchive && <Badge tone="warning">Archived</Badge>}
          </span>
        }
        actions={
          <>
            <Button icon={<Plus className="size-4" />} onClick={() => h.create('section', c.id)}>
              Add section
            </Button>
            <LinkButton to={`/study/new${qs({ course: c.id })}`} variant="primary" icon={<Play className="size-4 fill-current" />}>
              Start session
            </LinkButton>
            <Menu
              label="Course actions"
              items={[
                { label: 'Edit course', icon: <Pencil />, onSelect: () => h.edit('course', c) },
                firstSection && { label: 'Create card', icon: <Plus />, onSelect: () => navigate(`/cards/new?section=${firstSection.id}`) },
                { label: 'Import cards from CSV…', icon: <FileUp />, separatorBefore: true, onSelect: () => setCsv(true) },
                { label: 'Export cards as CSV', icon: <FileDown />, onSelect: () => downloadUrl(`/api/export/csv?courseId=${c.id}`) },
                { label: 'Export course package (.zip)', icon: <Download />, onSelect: () => downloadUrl(`/api/export/course/${c.id}`) },
                { label: 'Duplicate to semester…', icon: <Copy />, separatorBefore: true, onSelect: () => h.duplicateCourse(c) },
                { label: 'Move to semester…', icon: <FolderInput />, onSelect: () => h.moveCourse(c) },
                c.archivedAt
                  ? { label: 'Unarchive course', icon: <ArchiveRestore />, onSelect: () => setArchived(false, 'course', c.id, c.title) }
                  : { label: 'Archive course', icon: <Archive />, onSelect: () => setArchived(true, 'course', c.id, c.title) },
                { label: 'Move to trash', icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: () => h.remove('course', c.id, c.title, () => navigate('/')) },
              ]}
            />
          </>
        }
      />
      {c.description && <p className="-mt-3 mb-6 max-w-3xl whitespace-pre-wrap text-text-2">{c.description}</p>}
      {st.inArchive && (
        <Alert tone="warning" className="mb-6">
          This course (or its semester/program) is archived, so its cards are not offered in study sessions.
        </Alert>
      )}

      <div className="mb-8 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border shadow-soft sm:grid-cols-4">
        <Stat label="Due today" value={counts.due} />
        <Stat label="New" value={counts.new} />
        <Stat label="Cards" value={counts.total} hint={counts.suspended ? `${counts.suspended} suspended` : undefined} />
        <Stat label="Sections" value={active.length} hint={allSections.length > active.length ? `${allSections.length - active.length} archived` : undefined} />
      </div>

      <SectionTitle id="sections-h">Sections</SectionTitle>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 basis-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input className="pl-9" type="search" placeholder="Filter sections and search cards in this course…" aria-label="Filter sections and search cards" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} label="Show archived" />
        {selected.size > 0 && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button variant="primary" icon={<Play className="size-4 fill-current" />} onClick={studySelected}>
              Study {plural(selected.size, 'section')}
            </Button>
          </div>
        )}
      </div>

      {allSections.length === 0 ? (
        <EmptyState icon={<Layers className="size-6" />} title="No sections yet" action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => h.create('section', c.id)}>Add section</Button>}>
          Sections can be lecture weeks, tutorials, readings or exam-revision topics.
        </EmptyState>
      ) : (
        <Panel as="div" className="overflow-hidden">
          <div className="flex items-center gap-3 border-b border-border bg-surface-2/60 px-4 py-2 text-xs font-medium text-muted">
            <input
              type="checkbox"
              aria-label="Select all active sections"
              className="size-[18px] accent-[var(--primary)]"
              checked={activeIds.length > 0 && activeIds.every((x) => selected.has(x))}
              onChange={(e) => setSelected(e.target.checked ? new Set(activeIds) : new Set())}
            />
            <span className="flex-1">Section</span>
            <span className="hidden w-48 text-right sm:block">Due · New · Cards</span>
            <span className="w-[116px]" />
          </div>
          {visible.length === 0 && <p className="px-5 py-6 text-muted">No sections match “{query}”.</p>}
          <ul className="divide-y divide-border">
            {visible.map((s, index) => (
              <SectionRow key={s.id} s={s} index={index} count={visible.length} selected={selected.has(s.id)} onToggle={() => toggle(s.id)} onMove={reorder} onArchive={setArchived} />
            ))}
          </ul>
        </Panel>
      )}

      {q && (
        <section className="mt-8" aria-labelledby="hits-h">
          <SectionTitle id="hits-h">Cards matching “{q}”</SectionTitle>
          {cardHits.data?.cards.length ? (
            <Panel as="div" className="divide-y divide-border overflow-hidden">
              {cardHits.data.cards.map((card) => (
                <CardRowCompact key={card.id} card={card} today={today ?? ''} showSection />
              ))}
            </Panel>
          ) : (
            <p className="text-muted">{cardHits.isFetching ? 'Searching…' : 'No cards found in this course.'}</p>
          )}
        </section>
      )}

      {csv && <CsvImportDialog courseId={c.id} courseTitle={c.title} sections={active} onClose={() => setCsv(false)} />}
    </div>
  );
}

function SectionRow({
  s,
  index,
  count,
  selected,
  onToggle,
  onMove,
  onArchive,
}: {
  s: TreeSection;
  index: number;
  count: number;
  selected: boolean;
  onToggle: () => void;
  onMove: (id: string, d: -1 | 1) => void;
  onArchive: (archived: boolean, level: 'section', id: string, title: string) => void;
}) {
  const h = useHierarchy();
  const navigate = useNavigate();
  const kind = SECTION_KINDS.find((k) => k.value === s.kind)?.label ?? s.kind;
  return (
    <li className={cn('flex items-center gap-3 px-4 py-3 transition-colors', selected && 'bg-primary-soft/50', s.archivedAt && 'opacity-70')}>
      <input type="checkbox" aria-label={`Select ${s.title}`} className="size-[18px] shrink-0 accent-[var(--primary)]" checked={selected} onChange={onToggle} disabled={!!s.archivedAt} />
      <div className="min-w-0 flex-1">
        <Link to={`/sections/${s.id}`} className="font-medium hover:underline">
          {s.title}
        </Link>
        <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
          <span>{kind}</span>
          {s.weekNumber !== null && <span>· Week {s.weekNumber}</span>}
          {s.date && <span>· {formatDate(s.date)}</span>}
          {s.archivedAt && <Badge tone="warning">Archived</Badge>}
          <span className="sm:hidden">
            · {s.counts.due} due · {s.counts.new} new · {s.counts.total} cards
          </span>
        </p>
      </div>
      <div className="hidden w-48 justify-end gap-4 text-sm tabular-nums sm:flex">
        <span className={cn(s.counts.due > 0 ? 'font-semibold text-primary-text' : 'text-muted')}>{s.counts.due}</span>
        <span className="text-muted">{s.counts.new}</span>
        <span className="text-text-2">{s.counts.total}</span>
      </div>
      <div className="flex w-[116px] shrink-0 items-center justify-end">
        <IconButton size="sm" label="Move section up" onClick={() => onMove(s.id, -1)} disabled={index === 0}>
          <ArrowUp className="size-4" />
        </IconButton>
        <IconButton size="sm" label="Move section down" onClick={() => onMove(s.id, 1)} disabled={index === count - 1}>
          <ArrowDown className="size-4" />
        </IconButton>
        <Menu
          label={`Actions for ${s.title}`}
          items={[
            { label: 'Create card', icon: <Plus />, onSelect: () => navigate(`/cards/new?section=${s.id}`) },
            { label: 'Study this section', icon: <Play />, onSelect: () => navigate(`/study/new?sections=${s.id}`) },
            { label: 'Edit section', icon: <Pencil />, separatorBefore: true, onSelect: () => h.edit('section', s) },
            { label: 'Move to another course…', icon: <FolderInput />, onSelect: () => h.moveSection(s) },
            s.archivedAt
              ? { label: 'Unarchive', icon: <ArchiveRestore />, onSelect: () => onArchive(false, 'section', s.id, s.title) }
              : { label: 'Archive', icon: <Archive />, onSelect: () => onArchive(true, 'section', s.id, s.title) },
            { label: 'Move to trash', icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: () => h.remove('section', s.id, s.title) },
          ]}
        />
      </div>
    </li>
  );
}
