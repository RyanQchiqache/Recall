import { Archive, ArchiveRestore, Bookmark, FileDown, FileText, FolderInput, Pause, Pencil, Play, Plus, Search, Tag, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { SECTION_KINDS } from '../../shared/catalog.ts';
import type { CardFilter } from '../../shared/types.ts';
import { CardRow, MoveCardsDialog, TagCardsDialog } from '../components/CardList.tsx';
import { useHierarchy } from '../components/HierarchyDialogs.tsx';
import { Breadcrumbs, PageHeader } from '../components/layout/AppShell.tsx';
import { Button, LinkButton } from '../components/ui/Button.tsx';
import { ConfirmDialog } from '../components/ui/Dialog.tsx';
import { Alert, Badge, EmptyState, ErrorState, PageLoader, Panel } from '../components/ui/Feedback.tsx';
import { Input, Segmented } from '../components/ui/Form.tsx';
import { Menu } from '../components/ui/Menu.tsx';
import { useToast } from '../components/ui/Toast.tsx';
import { api, downloadUrl, errorMessage } from '../lib/api.ts';
import { formatDate, plural } from '../lib/format.ts';
import { invalidateContent, useCards, useDashboard, useSection } from '../lib/queries.ts';
import { useDebounced } from '../lib/util.ts';

const FILTERS: { value: CardFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'due', label: 'Due' },
  { value: 'notDue', label: 'Scheduled' },
  { value: 'weak', label: 'Weak' },
  { value: 'bookmarked', label: 'Bookmarked' },
  { value: 'suspended', label: 'Suspended' },
];

export function SectionPage() {
  const { id } = useParams();
  const section = useSection(id);
  const dash = useDashboard();
  const h = useHierarchy();
  const toast = useToast();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<CardFilter>('all');
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 200);
  const cards = useCards({ sectionId: id, filter: filter === 'all' ? undefined : filter, q: q || undefined, limit: 2000 }, !!id);
  const allCards = useCards({ sectionId: id, limit: 2000 }, !!id);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<'move' | 'tag' | 'delete' | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);

  if (section.isLoading) return <PageLoader />;
  if (section.error) return <ErrorState error={section.error} onRetry={() => section.refetch()} />;
  const s = section.data!.item;
  const st = section.data!.state;
  const today = dash.data?.today ?? '';
  const list = cards.data?.cards ?? [];
  const all = allCards.data?.cards ?? [];
  const counts = {
    total: all.length,
    due: all.filter((c) => c.status === 'due').length,
    new: all.filter((c) => c.status === 'new').length,
    suspended: all.filter((c) => c.status === 'suspended').length,
  };
  const kind = SECTION_KINDS.find((k) => k.value === s.kind)?.label ?? s.kind;
  const ids = [...selected].filter((x) => list.some((c) => c.id === x));
  const toggle = (cid: string) => {
    const n = new Set(selected);
    if (n.has(cid)) n.delete(cid);
    else n.add(cid);
    setSelected(n);
  };
  const bulk = async (action: string, msg: string) => {
    try {
      await api.post('/api/cards/bulk', { ids, action });
      invalidateContent();
      setSelected(new Set());
      toast.success(msg);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const reorder = async (cardId: string, direction: -1 | 1) => {
    const index = all.findIndex((card) => card.id === cardId);
    const neighbour = all[index + direction];
    if (index < 0 || !neighbour) return;
    const ordered = all.map((card) => card.id);
    [ordered[index], ordered[index + direction]] = [ordered[index + direction], ordered[index]];
    try {
      await api.post('/api/cards/reorder', { sectionId: s.id, ids: ordered });
      invalidateContent();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const setArchived = async (archived: boolean) => {
    try {
      await api.patch(`/api/sections/${s.id}`, { archived });
      invalidateContent();
      toast.success(archived ? 'Section archived' : 'Section unarchived');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        crumbs={<Breadcrumbs crumbs={section.data!.breadcrumbs} />}
        title={s.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge>{kind}</Badge>
            {s.weekNumber !== null && <span>Week {s.weekNumber}</span>}
            {s.date && <span>· {formatDate(s.date)}</span>}
            <span>
              · {counts.due} due · {counts.new} new · {plural(counts.total, 'card')}
            </span>
            {st.inArchive && <Badge tone="warning">Archived</Badge>}
          </span>
        }
        actions={
          <>
            <Button onClick={() => navigate(`/study/new?sections=${s.id}`)} icon={<Play className="size-4 fill-current" />} disabled={counts.total === 0}>
              Study section
            </Button>
            <LinkButton to={`/cards/new?section=${s.id}`} variant="primary" icon={<Plus className="size-4" />}>
              Create card
            </LinkButton>
            <Menu
              label="Section actions"
              items={[
                { label: 'Edit section', icon: <Pencil />, onSelect: () => h.edit('section', s) },
                { label: 'Move to another course…', icon: <FolderInput />, onSelect: () => h.moveSection(s) },
                { label: 'Export cards as CSV', icon: <FileDown />, onSelect: () => downloadUrl(`/api/export/csv?sectionId=${s.id}`) },
                s.archivedAt ? { label: 'Unarchive', icon: <ArchiveRestore />, onSelect: () => setArchived(false) } : { label: 'Archive', icon: <Archive />, onSelect: () => setArchived(true) },
                { label: 'Move to trash', icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: () => h.remove('section', s.id, s.title, () => navigate(`/courses/${s.courseId}`)) },
              ]}
            />
          </>
        }
      />
      {st.inArchive && (
        <Alert tone="warning" className="mb-5">
          This section is archived (directly or through its course, semester or program), so its cards are not offered in study sessions.
        </Alert>
      )}
      {s.notes && (
        <Panel className="mb-6 px-5 py-4">
          <button className="flex w-full items-center gap-2 text-left text-sm font-medium text-text-2" aria-expanded={notesOpen} onClick={() => setNotesOpen(!notesOpen)}>
            <FileText className="size-4" aria-hidden /> Notes {notesOpen ? '' : '— show'}
          </button>
          {notesOpen && <p className="mt-2 whitespace-pre-wrap text-[15px] text-text-2">{s.notes}</p>}
        </Panel>
      )}

      <div className="mb-4 flex flex-col gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input className="pl-9" type="search" placeholder="Search questions, answers and tags in this section…" aria-label="Search cards in this section" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="overflow-x-auto">
          <Segmented ariaLabel="Filter cards" value={filter} onChange={(f) => setFilter(f)} options={FILTERS} />
        </div>
      </div>

      {ids.length > 0 && (
        <div className="anim-pop sticky top-16 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 shadow-pop lg:top-3" role="toolbar" aria-label="Bulk actions">
          <span className="px-1 text-sm font-medium">{plural(ids.length, 'card')} selected</span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" icon={<FolderInput className="size-4" />} onClick={() => setDialog('move')}>
            Move
          </Button>
          <Button size="sm" variant="ghost" icon={<Tag className="size-4" />} onClick={() => setDialog('tag')}>
            Tag
          </Button>
          <Button size="sm" variant="ghost" icon={<Bookmark className="size-4" />} onClick={() => bulk('bookmark', 'Bookmarked')}>
            Bookmark
          </Button>
          <Button size="sm" variant="ghost" icon={<Pause className="size-4" />} onClick={() => bulk('suspend', `Suspended ${plural(ids.length, 'card')}`)}>
            Suspend
          </Button>
          <Button size="sm" variant="ghost" icon={<Play className="size-4" />} onClick={() => bulk('unsuspend', `Unsuspended ${plural(ids.length, 'card')}`)}>
            Unsuspend
          </Button>
          <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => setDialog('delete')}>
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {cards.isLoading ? (
        <PageLoader label="Loading cards" />
      ) : cards.error ? (
        <ErrorState error={cards.error} onRetry={() => cards.refetch()} />
      ) : counts.total === 0 ? (
        <EmptyState
          icon={<FileText className="size-6" />}
          title="No cards in this section yet"
          action={
            <LinkButton to={`/cards/new?section=${s.id}`} variant="primary" icon={<Plus className="size-4" />}>
              Create card
            </LinkButton>
          }
        >
          Write questions and answers with Markdown, equations, code and images.
        </EmptyState>
      ) : list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border-strong px-5 py-8 text-center text-muted">No cards match this filter{q ? ` and “${q}”` : ''}.</p>
      ) : (
        <Panel as="div" className="overflow-hidden">
          <div className="flex items-center gap-3 border-b border-border bg-surface-2/60 px-4 py-2 text-xs font-medium text-muted">
            <input
              type="checkbox"
              aria-label="Select all shown cards"
              className="size-[18px] accent-[var(--primary)]"
              checked={list.length > 0 && list.every((c) => selected.has(c.id))}
              onChange={(e) => setSelected(e.target.checked ? new Set(list.map((c) => c.id)) : new Set())}
            />
            <span>{plural(list.length, 'card')}</span>
          </div>
          <ul className="divide-y divide-border">
            {list.map((c, index) => (
              <CardRow
                key={c.id}
                card={c}
                today={today}
                selected={selected.has(c.id)}
                onToggle={() => toggle(c.id)}
                onMove={filter === 'all' && !q ? (direction) => reorder(c.id, direction) : undefined}
                first={index === 0}
                last={index === list.length - 1}
              />
            ))}
          </ul>
        </Panel>
      )}

      {dialog === 'move' && <MoveCardsDialog ids={ids} currentSectionId={s.id} onClose={() => setDialog(null)} onDone={() => setSelected(new Set())} />}
      {dialog === 'tag' && <TagCardsDialog ids={ids} onClose={() => setDialog(null)} onDone={() => setSelected(new Set())} />}
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Move ${plural(ids.length, 'card')} to the trash?`}
        tone="danger"
        confirmLabel="Move to trash"
        onConfirm={() => bulk('delete', `Moved ${plural(ids.length, 'card')} to the trash. Restore them from Trash if needed.`)}
      >
        They disappear from this section and from study. Their history is kept until you delete them permanently from the trash.
      </ConfirmDialog>
    </>
  );
}
