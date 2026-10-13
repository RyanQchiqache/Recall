import { ArchiveRestore, FileText, FolderClosed, GraduationCap, Layers, Trash2, CalendarRange, BookOpen } from 'lucide-react';
import { useState } from 'react';
import type { TrashItem } from '../../shared/types.ts';
import { PageHeader } from '../components/layout/AppShell.tsx';
import { Button } from '../components/ui/Button.tsx';
import { ConfirmDialog } from '../components/ui/Dialog.tsx';
import { Alert, Badge, EmptyState, ErrorState, PageLoader, Panel } from '../components/ui/Feedback.tsx';
import { useToast } from '../components/ui/Toast.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { formatDateTime, mdPreview, plural } from '../lib/format.ts';
import { invalidateContent, useTrash } from '../lib/queries.ts';

const ICON = { program: GraduationCap, semester: CalendarRange, course: BookOpen, section: Layers, card: FileText };
const LABEL = { program: 'Study program', semester: 'Semester', course: 'Course', section: 'Section', card: 'Card' };

function impactText(i: TrashItem): string {
  const parts = [
    i.impact.semesters && plural(i.impact.semesters, 'semester'),
    i.impact.courses && plural(i.impact.courses, 'course'),
    i.impact.sections && plural(i.impact.sections, 'section'),
    i.type !== 'card' && plural(i.impact.cards, 'card'),
    i.impact.reviews && plural(i.impact.reviews, 'recorded review'),
  ].filter(Boolean);
  return parts.join(', ');
}

export function TrashPage() {
  const trash = useTrash();
  const toast = useToast();
  const [purgeItem, setPurgeItem] = useState<TrashItem | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);

  const restore = async (i: TrashItem) => {
    try {
      await api.post('/api/trash/restore', { type: i.type, id: i.id });
      invalidateContent();
      toast.success(i.parentInTrash ? `Restored — it reappears once its parent is restored too.` : `Restored “${mdPreview(i.title, 60)}”`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (trash.isLoading) return <PageLoader />;
  if (trash.error) return <ErrorState error={trash.error} onRetry={() => trash.refetch()} />;
  const items = trash.data!;
  const total = items.reduce((n, i) => n + (i.type === 'card' ? 1 : i.impact.cards), 0);

  return (
    <>
      <PageHeader
        title="Trash"
        subtitle="Deleted items stay here, with their history, until you delete them permanently."
        actions={
          items.length > 0 && (
            <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setEmptyOpen(true)}>
              Empty trash
            </Button>
          )
        }
      />
      {items.length === 0 ? (
        <EmptyState icon={<FolderClosed className="size-6" />} title="The trash is empty">
          Items you delete appear here first, so you can restore them.
        </EmptyState>
      ) : (
        <Panel as="div" className="divide-y divide-border overflow-hidden">
          {items.map((i) => {
            const Icon = ICON[i.type];
            return (
              <div key={`${i.type}-${i.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                  <Icon className="size-[18px]" aria-hidden />
                </span>
                <div className="min-w-0 flex-1 basis-64">
                  <p className="line-clamp-1 font-medium">{i.type === 'card' ? mdPreview(i.title, 140) : i.title}</p>
                  <p className="text-sm text-muted">
                    <Badge className="mr-1.5">{LABEL[i.type]}</Badge>
                    {i.context && <span>{i.context} · </span>}
                    deleted {formatDateTime(i.deletedAt)}
                    {impactText(i) && <span> · {impactText(i)}</span>}
                  </p>
                  {i.parentInTrash && <p className="mt-0.5 text-xs text-warning">Its parent is also in the trash.</p>}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" icon={<ArchiveRestore className="size-4" />} onClick={() => restore(i)}>
                    Restore
                  </Button>
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => setPurgeItem(i)} disabled={i.impact.openSessionCards > 0}>
                    Delete permanently
                  </Button>
                </div>
              </div>
            );
          })}
        </Panel>
      )}

      <ConfirmDialog
        open={!!purgeItem}
        onOpenChange={(o) => !o && setPurgeItem(null)}
        title="Delete permanently?"
        tone="danger"
        confirmLabel="Delete permanently"
        onConfirm={async () => {
          if (!purgeItem) return;
          try {
            await api.del(`/api/trash/${purgeItem.type}/${purgeItem.id}`);
            invalidateContent();
            toast.success('Deleted permanently');
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      >
        {purgeItem && (
          <>
            <p>
              “{purgeItem.type === 'card' ? mdPreview(purgeItem.title, 80) : purgeItem.title}” {impactText(purgeItem) ? `and ${impactText(purgeItem)}` : ''} will be removed for good. This cannot be undone.
            </p>
            <p className="mt-2 text-sm text-muted">Your automatic snapshots and exported backups are not affected.</p>
          </>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={emptyOpen}
        onOpenChange={setEmptyOpen}
        title="Empty the trash?"
        tone="danger"
        confirmLabel="Delete everything permanently"
        onConfirm={async () => {
          try {
            const r = await api.post<{ removed: number }>('/api/trash/empty');
            invalidateContent();
            toast.success(`Permanently deleted ${plural(r.removed, 'item')}`);
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      >
        <p>
          {plural(items.length, 'item')} ({plural(total, 'card')} in total) will be deleted permanently, including their review history. This cannot be undone.
        </p>
        {items.some((i) => i.impact.openSessionCards > 0) && <Alert tone="warning" className="mt-3">Items used by the open study session are kept.</Alert>}
      </ConfirmDialog>
    </>
  );
}
