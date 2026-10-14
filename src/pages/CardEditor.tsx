import { useQuery } from '@tanstack/react-query';
import { Bookmark, ChevronDown, Copy, Lightbulb, Pause, Play, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';
import type { Card, Crumb, Section } from '../../shared/types.ts';
import { SectionPicker, StatusBadge } from '../components/CardList.tsx';
import { useHierarchy } from '../components/HierarchyDialogs.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { MarkdownEditor, type MarkdownEditorHandle } from '../components/MarkdownEditor.tsx';
import { Breadcrumbs, PageHeader } from '../components/layout/AppShell.tsx';
import { TagInput } from '../components/TagInput.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Modal } from '../components/ui/Dialog.tsx';
import { Alert, ErrorState, Kbd, PageLoader, Panel } from '../components/ui/Feedback.tsx';
import { Checkbox, Field, Input } from '../components/ui/Form.tsx';
import { useToast } from '../components/ui/Toast.tsx';
import { ApiError, api, errorMessage } from '../lib/api.ts';
import { formatDate, formatDateTime, plural } from '../lib/format.ts';
import { invalidateContent, queryClient, useCard, useDashboard } from '../lib/queries.ts';
import { cn, dialogOpen } from '../lib/util.ts';

interface Form {
  sectionId: string;
  front: string;
  back: string;
  explanation: string;
  hint: string;
  source: string;
  tags: string[];
  bookmarked: boolean;
}

const EMPTY: Omit<Form, 'sectionId'> = { front: '', back: '', explanation: '', hint: '', source: '', tags: [], bookmarked: false };

function fromCard(c: Card): Form {
  return { sectionId: c.sectionId, front: c.front, back: c.back, explanation: c.explanation, hint: c.hint, source: c.source, tags: c.tags, bookmarked: c.bookmarked };
}

const same = (a: Form, b: Form) => JSON.stringify(a) === JSON.stringify(b);

type DraftState = 'idle' | 'saving' | 'saved' | 'error';

export function CardEditor() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const sectionParam = params.get('section') ?? '';
  const card = useCard(id);
  if (id && card.isLoading) return <PageLoader />;
  if (id && card.error) return <ErrorState error={card.error} onRetry={() => card.refetch()} />;
  // Remount the inner editor whenever the target changes so state never leaks between cards.
  return <EditorInner key={id ?? `new:${sectionParam}`} card={card.data?.card ?? null} crumbs={card.data?.breadcrumbs} initialSection={sectionParam} first={params.get('first') === '1'} />;
}

function EditorInner({ card, crumbs, initialSection, first }: { card: Card | null; crumbs?: Crumb[]; initialSection: string; first: boolean }) {
  const isNew = !card;
  const navigate = useNavigate();
  const toast = useToast();
  const h = useHierarchy();
  const dash = useDashboard();
  const baseline = useRef<Form>(card ? fromCard(card) : { ...EMPTY, sectionId: initialSection });
  const [form, setForm] = useState<Form>(baseline.current);
  const [revision, setRevision] = useState(card?.revision ?? 0);
  const [errors, setErrors] = useState<{ front?: string; back?: string; section?: string; general?: string }>({});
  const [saving, setSaving] = useState(false);
  const [draftState, setDraftState] = useState<DraftState>('idle');
  const [restored, setRestored] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(() => !!(card && (card.explanation || card.hint || card.source || card.tags.length)));
  const [conflict, setConflict] = useState<Card | null>(null);
  const frontRef = useRef<MarkdownEditorHandle>(null);
  // One draft key per editor session: switching the section of a new card must not orphan the draft.
  const liveKey = card ? `card:${card.id}` : form.sectionId ? `new:${form.sectionId}` : null;
  const [draftKeyAtLoad] = useState(liveKey);
  const [stableKey, setStableKey] = useState(liveKey);
  useEffect(() => {
    if (!stableKey && liveKey) setStableKey(liveKey);
  }, [stableKey, liveKey]);
  const draftKey = stableKey ?? liveKey;
  const tagPending = useRef('');
  const pendingDraft = useRef<{ key: string; body: unknown } | null>(null);
  const [staleDraft, setStaleDraft] = useState(false);
  const dirty = !same(form, baseline.current);
  const justSaved = useRef(false);

  const sectionQuery = useQuery({
    queryKey: ['section', form.sectionId],
    queryFn: () => api.get<{ item: Section; breadcrumbs: Crumb[] }>(`/api/sections/${form.sectionId}`),
    enabled: !!form.sectionId,
  });

  // Restore a saved draft once on load.
  useEffect(() => {
    if (!draftKeyAtLoad) return;
    let cancelled = false;
    api
      .get<{ payload: Partial<Form> & { baseRevision?: number }; updatedAt: string } | null>(`/api/drafts/${draftKeyAtLoad}`)
      .then((d) => {
        if (cancelled || !d?.payload) return;
        const { baseRevision, ...rest } = d.payload;
        const merged: Form = { ...baseline.current, ...rest, tags: Array.isArray(rest.tags) ? rest.tags : baseline.current.tags };
        if (!same(merged, baseline.current)) {
          setForm(merged);
          setRestored(d.updatedAt);
          if (card && typeof baseRevision === 'number' && baseRevision !== card.revision) {
            // The card changed after this draft was written: saving will ask which version to keep.
            setRevision(baseRevision);
            setStaleDraft(true);
          }
          if (merged.explanation || merged.hint || merged.source || merged.tags.length) setDetailsOpen(true);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [draftKeyAtLoad]);

  // Autosave drafts to the local database (debounced).
  useEffect(() => {
    if (!draftKey || !dirty || justSaved.current) return;
    setDraftState('saving');
    const body = { ...form, baseRevision: revision };
    pendingDraft.current = { key: draftKey, body };
    const t = setTimeout(async () => {
      try {
        await api.put(`/api/drafts/${draftKey}`, body);
        if (pendingDraft.current?.body === body) pendingDraft.current = null;
        setDraftState('saved');
      } catch {
        setDraftState('error');
      }
    }, 600);
    return () => clearTimeout(t);
  }, [form, draftKey, dirty, revision]);

  // Flush a draft that is still waiting for its debounce when leaving the editor or closing the tab.
  useEffect(() => {
    const flush = () => {
      const p = pendingDraft.current;
      if (!p || justSaved.current) return;
      pendingDraft.current = null;
      void fetch(`/api/drafts/${p.key}`, {
        method: 'PUT',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-Recall-Client': '1' },
        body: JSON.stringify(p.body),
      }).catch(() => undefined);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  // Warn before leaving with unsaved edits only if the draft could not be stored.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && draftState === 'error' && currentLocation.pathname !== nextLocation.pathname);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const validate = () => {
    const e: typeof errors = {};
    if (!form.sectionId) e.section = 'Choose a section for this card.';
    if (!form.front.trim()) e.front = 'The front (question) is required. An image on its own is fine.';
    if (!form.back.trim()) e.back = 'The back (answer) is required.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = async (andNext: boolean, overwrite = false) => {
    if (saving || !validate()) return;
    setSaving(true);
    try {
      const pendingTags = tagPending.current.split(',').map((t) => t.trim()).filter(Boolean);
      const tags = [...form.tags, ...pendingTags.filter((t) => !form.tags.some((x) => x.toLowerCase() === t.toLowerCase()))];
      const body = { ...form, tags, source: form.source.trim() };
      let saved: Card;
      if (isNew) {
        saved = await api.post<Card>('/api/cards', body);
      } else {
        saved = await api.patch<Card>(`/api/cards/${card!.id}`, { ...body, revision: overwrite ? undefined : revision });
      }
      justSaved.current = true;
      pendingDraft.current = null;
      for (const k of new Set([draftKey, liveKey])) if (k) await api.del(`/api/drafts/${k}`).catch(() => undefined);
      invalidateContent();
      queryClient.setQueryData(['card', saved.id], (old: { card: Card; breadcrumbs: Crumb[] } | undefined) => (old ? { ...old, card: saved } : old));
      toast.success(isNew ? 'Card created' : 'Card saved');
      if (andNext) {
        const next: Form = { ...EMPTY, sectionId: form.sectionId, tags: form.tags, source: form.source };
        baseline.current = next;
        setForm(next);
        setRestored(null);
        setStaleDraft(false);
        setDraftState('idle');
        justSaved.current = false;
        requestAnimationFrame(() => frontRef.current?.focus());
      } else {
        baseline.current = form;
        navigate(`/sections/${saved.sectionId}`);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'revision_conflict') {
        setConflict((e.details as { current?: Card })?.current ?? null);
      } else {
        setErrors({ general: errorMessage(e) });
      }
    } finally {
      setSaving(false);
    }
  };

  const discardDraft = async () => {
    pendingDraft.current = null;
    if (draftKey) await api.del(`/api/drafts/${draftKey}`).catch(() => undefined);
    if (card) setRevision(card.revision);
    setStaleDraft(false);
    setForm(baseline.current);
    setRestored(null);
    setDraftState('idle');
  };

  // Keyboard: Cmd/Ctrl+Enter saves, +Shift saves and starts the next card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogOpen()) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void save(isNew && e.shiftKey);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const sectionTitle = sectionQuery.data?.item.title;
  const courseCrumb = sectionQuery.data?.breadcrumbs.find((c) => c.level === 'course');
  const breadcrumbList = crumbs ?? sectionQuery.data?.breadcrumbs ?? [];
  const today = dash.data?.today ?? '';
  const mod = useMemo(() => (navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'), []);
  const onError = (m: string) => toast.error(m);

  return (
    <>
      <PageHeader
        docTitle={isNew ? 'New card' : 'Edit card'}
        crumbs={<Breadcrumbs crumbs={breadcrumbList} current={isNew ? 'New card' : 'Edit card'} />}
        title={isNew ? 'Create card' : 'Edit card'}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {sectionTitle ? (
              <span>
                in <strong className="font-medium text-text-2">{sectionTitle}</strong>
                {courseCrumb && <> · {courseCrumb.title}</>}
              </span>
            ) : (
              <span>Choose a section below</span>
            )}
            <DraftIndicator state={draftState} dirty={dirty} />
          </span>
        }
        actions={
          card && (
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge card={card} today={today} />
              <Button
                size="sm"
                variant="ghost"
                icon={<Copy className="size-4" />}
                onClick={async () => {
                  try {
                    const c = await api.post<Card>(`/api/cards/${card.id}/duplicate`);
                    invalidateContent();
                    toast.success('Duplicated');
                    navigate(`/cards/${c.id}/edit`);
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              >
                Duplicate
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={card.suspendedAt ? <Play className="size-4" /> : <Pause className="size-4" />}
                onClick={async () => {
                  try {
                    const c = await api.patch<Card>(`/api/cards/${card.id}`, { suspended: !card.suspendedAt });
                    setRevision(c.revision);
                    invalidateContent();
                    toast.success(c.suspendedAt ? 'Suspended — excluded from study' : 'Unsuspended');
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              >
                {card.suspendedAt ? 'Unsuspend' : 'Suspend'}
              </Button>
              <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => h.remove('card', card.id, card.front.slice(0, 80) || 'Card', () => navigate(`/sections/${card.sectionId}`))}>
                Delete
              </Button>
            </div>
          )
        }
      />

      {first && isNew && (
        <Alert tone="info" className="mb-5" title="Write your first card">
          Put the question on the front and the answer on the back. Markdown, <code>$math$</code>, code blocks and pasted images all work, and you see the result on the right.
        </Alert>
      )}
      {restored && (
        <Alert tone={staleDraft ? 'warning' : 'info'} className="mb-5" action={<Button size="sm" variant="ghost" onClick={discardDraft}>Discard draft</Button>}>
          Restored unsaved changes from {formatDateTime(restored)}.
          {staleDraft && ' The card was changed elsewhere since then — when you save, you can choose which version to keep.'}
        </Alert>
      )}
      {errors.general && (
        <Alert tone="danger" className="mb-5">
          {errors.general}
        </Alert>
      )}
      {card?.schedule && (
        <p className="mb-5 text-sm text-muted">
          Next review {formatDate(card.schedule.dueDate)} · interval {plural(card.schedule.intervalDays, 'day')} · {plural(card.schedule.reviewCount, 'scheduled review')} · {plural(card.schedule.lapseCount, 'lapse')}. Editing the text keeps this history.
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
        className="grid gap-6 xl:grid-cols-2"
        noValidate
      >
        <div className="flex min-w-0 flex-col gap-5">
          <Field label="Section" htmlFor="card-section" error={errors.section}>
            <SectionPicker id="card-section" value={form.sectionId} onChange={(v) => set('sectionId', v)} />
          </Field>
          <div>
            <MarkdownEditor ref={frontRef} id="card-front" label="Front — question" value={form.front} onChange={(v) => set('front', v)} placeholder="e.g. Explain non-maximum suppression." minRows={4} invalid={!!errors.front} describedBy={errors.front ? 'front-err' : undefined} onError={onError} />
            {errors.front && (
              <p id="front-err" className="mt-1.5 text-sm text-danger" role="alert">
                {errors.front}
              </p>
            )}
          </div>
          <div>
            <MarkdownEditor id="card-back" label="Back — answer" value={form.back} onChange={(v) => set('back', v)} placeholder="The answer. Use $$ … $$ for display equations and ``` for code." minRows={6} invalid={!!errors.back} describedBy={errors.back ? 'back-err' : undefined} onError={onError} />
            {errors.back && (
              <p id="back-err" className="mt-1.5 text-sm text-danger" role="alert">
                {errors.back}
              </p>
            )}
          </div>

          <Panel as="div" className="shadow-none">
            <button type="button" className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left" aria-expanded={detailsOpen} aria-controls="card-details" onClick={() => setDetailsOpen(!detailsOpen)}>
              <span>
                <span className="block font-medium">More details</span>
                <span className="block text-sm text-muted">Explanation, hint, tags, source{form.tags.length ? ` · ${form.tags.map((t) => `#${t}`).join(' ')}` : ''}</span>
              </span>
              <ChevronDown className={cn('size-5 shrink-0 text-muted transition-transform duration-150', detailsOpen && 'rotate-180')} aria-hidden />
            </button>
            {detailsOpen && (
              <div id="card-details" className="flex flex-col gap-4 border-t border-border px-4 py-4">
                <MarkdownEditor id="card-explanation" label="Explanation (shown after the answer)" value={form.explanation} onChange={(v) => set('explanation', v)} minRows={3} onError={onError} />
                <Field label="Hint" optional htmlFor="card-hint" hint="Hidden until you ask for it while studying.">
                  <Input id="card-hint" value={form.hint} onChange={(e) => set('hint', e.target.value)} maxLength={10000} />
                </Field>
                <Field label="Tags" optional htmlFor="card-tags">
                  <TagInput id="card-tags" value={form.tags} onChange={(t) => set('tags', t)} pendingRef={tagPending} />
                </Field>
                <Field label="Source" optional htmlFor="card-source" hint="Free text, e.g. “Lecture 3, slide 24”.">
                  <Input id="card-source" value={form.source} onChange={(e) => set('source', e.target.value)} maxLength={500} />
                </Field>
                <Checkbox checked={form.bookmarked} onChange={(e) => set('bookmarked', e.target.checked)} label={<span className="inline-flex items-center gap-1.5"><Bookmark className="size-4" aria-hidden /> Bookmark this card</span>} />
              </div>
            )}
          </Panel>

          <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur sm:bottom-3 sm:mx-0 sm:rounded-xl sm:border sm:bg-surface sm:px-3 sm:shadow-pop sm:before:absolute sm:before:inset-x-[-2px] sm:before:bottom-full sm:before:h-4 sm:before:bg-bg sm:before:content-[''] sm:after:absolute sm:after:inset-x-[-2px] sm:after:top-full sm:after:h-3.5 sm:after:bg-bg sm:after:content-['']">
            <Button type="submit" variant="primary" loading={saving} icon={<Save className="size-4" />}>
              {isNew ? 'Save card' : 'Save changes'}
            </Button>
            {isNew && (
              <Button onClick={() => save(true)} disabled={saving}>
                Save & add next
              </Button>
            )}
            <Button variant="ghost" onClick={() => navigate(form.sectionId ? `/sections/${form.sectionId}` : -1 as never)}>
              {dirty ? 'Close (draft kept)' : 'Cancel'}
            </Button>
            <span className="ml-auto hidden items-center gap-1 text-xs text-muted md:flex">
              <Kbd>{mod}</Kbd>
              <Kbd>Enter</Kbd> save{isNew && <> · <Kbd>{mod}</Kbd><Kbd>Shift</Kbd><Kbd>Enter</Kbd> save & next</>}
            </span>
          </div>
        </div>

        <div className="min-w-0">
          <div className="sticky top-4 flex flex-col gap-4">
            <p className="text-sm font-medium text-text-2">Preview — as it appears when studying</p>
            <Panel className="p-6">
              <p className="mb-3 text-[13px] font-medium text-muted">Question</p>
              {form.front.trim() ? <Markdown className="text-[17px]">{form.front}</Markdown> : <p className="text-muted">The question appears here.</p>}
              {form.hint.trim() && (
                <p className="mt-4 inline-flex items-center gap-1.5 text-sm text-muted">
                  <Lightbulb className="size-4" aria-hidden /> Hint available
                </p>
              )}
            </Panel>
            <Panel className="p-6">
              <p className="mb-3 text-[13px] font-medium text-muted">Answer</p>
              {form.back.trim() ? <Markdown className="text-[17px]">{form.back}</Markdown> : <p className="text-muted">The answer appears here.</p>}
              {form.explanation.trim() && (
                <div className="mt-5 border-t border-border pt-4">
                  <p className="mb-2 text-[13px] font-medium text-muted">Explanation</p>
                  <Markdown className="text-[15px] text-text-2">{form.explanation}</Markdown>
                </div>
              )}
              {form.source.trim() && <p className="mt-4 text-sm text-muted">Source: {form.source}</p>}
            </Panel>
          </div>
        </div>
      </form>

      {conflict && (
        <Modal
          open
          onOpenChange={(o) => !o && setConflict(null)}
          title="This card changed elsewhere"
          description="It was edited (for example in another tab or by a bulk action) after you opened it."
          footer={
            <>
              <Button
                onClick={() => {
                  const f = fromCard(conflict);
                  baseline.current = f;
                  setForm(f);
                  setRevision(conflict.revision);
                  setConflict(null);
                  setRestored(null);
                  setStaleDraft(false);
                  pendingDraft.current = null;
                  if (draftKey) void api.del(`/api/drafts/${draftKey}`).catch(() => undefined);
                }}
              >
                Load their version
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setRevision(conflict.revision);
                  setConflict(null);
                  void save(false, true);
                }}
              >
                Keep mine and overwrite
              </Button>
            </>
          }
        >
          <div className="grid gap-3 text-sm">
            <p className="font-medium">Current saved front:</p>
            <div className="max-h-48 overflow-auto rounded-xl bg-surface-2 p-3">
              <Markdown>{conflict.front}</Markdown>
            </div>
          </div>
        </Modal>
      )}
      {blocker.state === 'blocked' && (
        <Modal
          open
          onOpenChange={(o) => !o && blocker.reset?.()}
          title="Leave without saving?"
          footer={
            <>
              <Button onClick={() => blocker.reset?.()}>Stay</Button>
              <Button variant="danger" onClick={() => blocker.proceed?.()}>
                Leave
              </Button>
            </>
          }
        >
          <p>Your changes could not be stored as a draft, so leaving now would lose them.</p>
        </Modal>
      )}
    </>
  );
}

function DraftIndicator({ state, dirty }: { state: DraftState; dirty: boolean }) {
  if (!dirty && state !== 'saved') return null;
  const text = state === 'saving' ? 'Saving draft…' : state === 'saved' ? 'Draft saved locally' : state === 'error' ? 'Draft could not be saved' : 'Unsaved changes';
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm', state === 'error' ? 'text-danger' : 'text-muted')} role="status" aria-live="polite">
      <span className={cn('size-1.5 rounded-full', state === 'error' ? 'bg-danger' : state === 'saved' ? 'bg-success' : 'bg-border-strong')} aria-hidden />
      {text}
    </span>
  );
}
