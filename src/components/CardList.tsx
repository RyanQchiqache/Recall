import { Bookmark, BookmarkMinus, Copy, FolderInput, Pause, Pencil, Play, Tag, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Card } from '../../shared/types.ts';
import { api, errorMessage } from '../lib/api.ts';
import { formatDate, mdPreview, plural, relativeDay } from '../lib/format.ts';
import { invalidateContent, useTree } from '../lib/queries.ts';
import { cn } from '../lib/util.ts';
import { RatingBadge } from './ratingUi.tsx';
import { Button } from './ui/Button.tsx';
import { Alert, Badge } from './ui/Feedback.tsx';
import { Field, Input, Select, Segmented } from './ui/Form.tsx';
import { Modal } from './ui/Dialog.tsx';
import { Menu } from './ui/Menu.tsx';
import { useToast } from './ui/Toast.tsx';
import { useHierarchy } from './HierarchyDialogs.tsx';
import { Tip } from './ui/Tooltip.tsx';

export function StatusBadge({ card, today }: { card: Card; today: string }) {
  switch (card.status) {
    case 'suspended':
      return <Badge tone="warning" icon={<Pause className="size-3" aria-hidden />}>Suspended</Badge>;
    case 'new':
      return <Badge tone="primary">New</Badge>;
    case 'due':
      return <Badge tone="danger">Due {card.schedule && card.schedule.dueDate < today ? relativeDay(card.schedule.dueDate, today).replace('ago', 'overdue') : 'today'}</Badge>;
    default:
      return (
        <Tip content={card.schedule ? `Next review ${formatDate(card.schedule.dueDate)} · interval ${plural(card.schedule.intervalDays, 'day')}` : ''}>
          <span>
            <Badge>Due {card.schedule ? relativeDay(card.schedule.dueDate, today) : ''}</Badge>
          </span>
        </Tip>
      );
  }
}

/** Compact search-result style row. */
export function CardRowCompact({ card, today, showSection }: { card: Card; today: string; showSection?: boolean }) {
  return (
    <Link to={`/cards/${card.id}/edit`} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-[15px]">{mdPreview(card.front, 220) || <em className="text-muted">Image-only question</em>}</p>
        <p className="mt-0.5 line-clamp-1 text-sm text-muted">{mdPreview(card.back, 160)}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {showSection && (
            <span className="text-xs text-muted">
              {card.courseTitle} › {card.sectionTitle}
            </span>
          )}
          {card.tags.map((t) => (
            <Badge key={t} className="!py-0">
              #{t}
            </Badge>
          ))}
        </div>
      </div>
      <div className="shrink-0">
        <StatusBadge card={card} today={today} />
      </div>
    </Link>
  );
}

export function CardRow({ card, today, selected, onToggle }: { card: Card; today: string; selected: boolean; onToggle: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const h = useHierarchy();
  const [moving, setMoving] = useState(false);
  const patch = async (body: Record<string, unknown>, msg: string) => {
    try {
      await api.patch(`/api/cards/${card.id}`, body);
      invalidateContent();
      toast.success(msg);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <li className={cn('group flex items-start gap-3 px-4 py-3 transition-colors', selected ? 'bg-primary-soft/50' : 'hover:bg-surface-2/60', card.status === 'suspended' && 'opacity-75')}>
      <input type="checkbox" aria-label={`Select card: ${mdPreview(card.front, 60)}`} checked={selected} onChange={onToggle} className="mt-1 size-[18px] shrink-0 accent-[var(--primary)]" />
      <Link to={`/cards/${card.id}/edit`} className="min-w-0 flex-1 rounded-md">
        <p className="line-clamp-2 text-[15px] font-medium">{mdPreview(card.front, 240) || <em className="font-normal text-muted">Image-only question</em>}</p>
        <p className="mt-0.5 line-clamp-1 text-sm text-muted">{mdPreview(card.back, 180)}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <StatusBadge card={card} today={today} />
          {card.lastRating && <RatingBadge rating={card.lastRating} />}
          {card.tags.map((t) => (
            <Badge key={t}>#{t}</Badge>
          ))}
          {card.source && <span className="text-xs text-muted">· {card.source}</span>}
        </div>
      </Link>
      <div className="flex shrink-0 items-center">
        <Tip content={card.bookmarked ? 'Remove bookmark' : 'Bookmark'}>
          <button
            aria-label={card.bookmarked ? 'Remove bookmark' : 'Bookmark'}
            aria-pressed={card.bookmarked}
            onClick={() => patch({ bookmarked: !card.bookmarked }, card.bookmarked ? 'Bookmark removed' : 'Bookmarked')}
            className={cn('inline-flex size-9 items-center justify-center rounded-lg hover:bg-surface-2', card.bookmarked ? 'text-primary-text' : 'text-muted')}
          >
            <Bookmark className={cn('size-4', card.bookmarked && 'fill-current')} />
          </button>
        </Tip>
        <Menu
          label="Card actions"
          items={[
            { label: 'Edit', icon: <Pencil />, onSelect: () => navigate(`/cards/${card.id}/edit`) },
            {
              label: 'Duplicate',
              icon: <Copy />,
              onSelect: async () => {
                try {
                  const c = await api.post<Card>(`/api/cards/${card.id}/duplicate`);
                  invalidateContent();
                  toast.success('Card duplicated', { label: 'Edit copy', onClick: () => navigate(`/cards/${c.id}/edit`) });
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              },
            },
            { label: 'Move to section…', icon: <FolderInput />, onSelect: () => setMoving(true) },
            card.suspendedAt
              ? { label: 'Unsuspend', icon: <Play />, onSelect: () => patch({ suspended: false }, 'Card unsuspended') }
              : { label: 'Suspend', icon: <Pause />, onSelect: () => patch({ suspended: true }, 'Card suspended — it won’t appear in study until you unsuspend it') },
            { label: 'Move to trash', icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: () => h.remove('card', card.id, mdPreview(card.front, 80) || 'Card') },
          ]}
        />
      </div>
      {moving && <MoveCardsDialog ids={[card.id]} currentSectionId={card.sectionId} onClose={() => setMoving(false)} />}
    </li>
  );
}

export function SectionPicker({ id, value, onChange, exclude }: { id: string; value: string; onChange: (v: string) => void; exclude?: string }) {
  const tree = useTree();
  const groups = (tree.data ?? []).flatMap((p) => p.semesters.flatMap((s) => s.courses.map((c) => ({ label: `${s.title} › ${c.title}`, sections: c.sections.filter((x) => x.id !== exclude) })))).filter((g) => g.sections.length);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose a section…</option>
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

export function MoveCardsDialog({ ids, currentSectionId, onClose, onDone }: { ids: string[]; currentSectionId?: string; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Move ${plural(ids.length, 'card')}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!target}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post('/api/cards/bulk', { ids, action: 'move', sectionId: target });
                invalidateContent();
                toast.success(`Moved ${plural(ids.length, 'card')}`);
                onDone?.();
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Move
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Destination section" htmlFor="move-target">
          <SectionPicker id="move-target" value={target} onChange={setTarget} exclude={currentSectionId} />
        </Field>
        <p className="text-sm text-muted">Schedules and review history move with the cards.</p>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

export function TagCardsDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'addTags' | 'removeTags'>('addTags');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = tags.split(',').map((t) => t.trim()).filter(Boolean);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Tag ${plural(ids.length, 'card')}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!list.length}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post('/api/cards/bulk', { ids, action: mode, tags: list });
                invalidateContent();
                toast.success(mode === 'addTags' ? 'Tags added' : 'Tags removed');
                onDone?.();
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {mode === 'addTags' ? 'Add tags' : 'Remove tags'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented
          ariaLabel="Tag action"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'addTags', label: 'Add' },
            { value: 'removeTags', label: 'Remove' },
          ]}
        />
        <Field label="Tags" htmlFor="bulk-tags" hint="Separate multiple tags with commas.">
          <Input id="bulk-tags" autoFocus value={tags} onChange={(e) => setTags(e.target.value)} placeholder="exam, derivation" />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

export { BookmarkMinus, Tag };
