import { useQuery } from '@tanstack/react-query';
import { Bookmark, Brackets, ChevronDown, Copy, FileText, ImageIcon, LayoutTemplate, Lightbulb, Pause, Play, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  emptyFields,
  NOTE_KIND_LABEL,
  NOTE_KINDS,
  noteProblems,
  noteTitle,
  renderNote,
  type BasicFields,
  type ClozeFields,
  type NoteFields,
  type NoteKind,
  type NoteOptions,
  type NoteTemplateDef,
  type OcclusionFields,
  type RenderedCard,
  type TemplateFields,
} from '../../shared/notes.ts';
import type { Card, Crumb, Note, NoteSaveResult, Section } from '../../shared/types.ts';
import { CardFace } from '../components/CardFace.tsx';
import { SectionPicker, StatusBadge } from '../components/CardList.tsx';
import { useHierarchy } from '../components/HierarchyDialogs.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { MarkdownEditor, type MarkdownEditorHandle } from '../components/MarkdownEditor.tsx';
import { OcclusionEditor } from '../components/OcclusionEditor.tsx';
import { Breadcrumbs, PageHeader } from '../components/layout/AppShell.tsx';
import { TagInput } from '../components/TagInput.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Modal } from '../components/ui/Dialog.tsx';
import { Alert, Badge, ErrorState, Kbd, PageLoader, Panel } from '../components/ui/Feedback.tsx';
import { Checkbox, Field, Input, Segmented, Select, Switch } from '../components/ui/Form.tsx';
import { useToast } from '../components/ui/Toast.tsx';
import { ApiError, api, errorMessage } from '../lib/api.ts';
import { formatDate, formatDateTime, mdPreview, plural, relativeDay } from '../lib/format.ts';
import { invalidateContent, queryClient, useCard, useDashboard, useTemplates } from '../lib/queries.ts';
import { cn, dialogOpen } from '../lib/util.ts';

interface Form {
  sectionId: string;
  kind: NoteKind;
  templateId: string | null;
  fields: NoteFields;
  options: NoteOptions;
  tags: string[];
  bookmarked: boolean;
}

const KIND_ICON: Record<NoteKind, typeof FileText> = { basic: FileText, cloze: Brackets, occlusion: ImageIcon, template: LayoutTemplate };
const KIND_HELP: Record<NoteKind, string> = {
  basic: 'A question and its answer. Optionally also ask it the other way round.',
  cloze: 'Text with gaps. Each gap number becomes its own card.',
  occlusion: 'An image with boxes over parts to name. Each box becomes its own card.',
  template: 'Your own fields and card layouts, reused for many notes.',
};

function fromNote(n: Note): Form {
  return { sectionId: n.sectionId, kind: n.kind, templateId: n.templateId, fields: n.fields, options: n.options, tags: n.tags, bookmarked: n.bookmarked };
}

function emptyForm(kind: NoteKind, sectionId: string, templateId: string | null = null): Form {
  return { sectionId, kind, templateId, fields: emptyFields(kind), options: kind === 'occlusion' ? { occlusionMode: 'hide-all' } : {}, tags: [], bookmarked: false };
}

/** Restore a draft, including ones saved before card types existed (plain front/back). */
function formFromDraft(base: Form, payload: Record<string, unknown>, fixedKind: boolean): Form {
  if (payload.fields && typeof payload.fields === 'object') {
    const kind = fixedKind ? base.kind : NOTE_KINDS.includes(payload.kind as NoteKind) ? (payload.kind as NoteKind) : base.kind;
    if (fixedKind && payload.kind !== base.kind) return base;
    return {
      ...base,
      kind,
      sectionId: typeof payload.sectionId === 'string' ? payload.sectionId : base.sectionId,
      templateId: typeof payload.templateId === 'string' ? payload.templateId : base.templateId,
      fields: { ...emptyFields(kind), ...(payload.fields as object) } as NoteFields,
      options: (payload.options as NoteOptions) ?? base.options,
      tags: Array.isArray(payload.tags) ? (payload.tags as string[]) : base.tags,
      bookmarked: typeof payload.bookmarked === 'boolean' ? payload.bookmarked : base.bookmarked,
    };
  }
  if (typeof payload.front === 'string' && base.kind === 'basic') {
    const p = payload as Record<string, string>;
    return { ...base, fields: { ...(base.fields as BasicFields), front: p.front ?? '', back: p.back ?? '', explanation: p.explanation ?? '', hint: p.hint ?? '', source: p.source ?? '' }, tags: Array.isArray(payload.tags) ? (payload.tags as string[]) : base.tags };
  }
  return base;
}

const same = (a: Form, b: Form) => JSON.stringify(a) === JSON.stringify(b);

type DraftState = 'idle' | 'saving' | 'saved' | 'error';

export function CardEditor() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const sectionParam = params.get('section') ?? '';
  const kindParam = params.get('kind') as NoteKind | null;
  const card = useCard(id);
  if (id && card.isLoading) return <PageLoader />;
  if (id && card.error) return <ErrorState error={card.error} onRetry={() => card.refetch()} />;
  // Remount the inner editor whenever the target changes so state never leaks between cards.
  return (
    <EditorInner
      key={id ?? `new:${sectionParam}`}
      card={card.data?.card ?? null}
      note={card.data?.note ?? null}
      crumbs={card.data?.breadcrumbs}
      initialSection={sectionParam}
      initialKind={kindParam && NOTE_KINDS.includes(kindParam) ? kindParam : 'basic'}
      initialTemplate={params.get('template')}
      first={params.get('first') === '1'}
    />
  );
}

function syncMessage(sync: NoteSaveResult['sync'], isNew: boolean): string {
  if (isNew) return sync.created === 1 ? 'Card created' : `${sync.created} cards created`;
  const parts = [
    sync.created && plural(sync.created, 'new card'),
    sync.restored && `${plural(sync.restored, 'card')} back with its history`,
    sync.retired && `${plural(sync.retired, 'card')} set aside (history kept)`,
  ].filter(Boolean);
  return parts.length ? `Saved · ${parts.join(' · ')}` : 'Card saved';
}

function EditorInner({
  card,
  note,
  crumbs,
  initialSection,
  initialKind,
  initialTemplate,
  first,
}: {
  card: Card | null;
  note: Note | null;
  crumbs?: Crumb[];
  initialSection: string;
  initialKind: NoteKind;
  initialTemplate: string | null;
  first: boolean;
}) {
  const isNew = !note;
  const navigate = useNavigate();
  const toast = useToast();
  const h = useHierarchy();
  const dash = useDashboard();
  // Archived templates still render existing notes; only the new-note picker hides them.
  const templates = useTemplates(true);
  const pickable = templates.data?.filter((t) => !t.archivedAt) ?? [];
  const baseline = useRef<Form>(note ? fromNote(note) : emptyForm(initialKind, initialSection, initialKind === 'template' ? initialTemplate : null));
  const [form, setForm] = useState<Form>(baseline.current);
  const [revision, setRevision] = useState(note?.revision ?? 0);
  const [errors, setErrors] = useState<{ fields?: string; section?: string; general?: string }>({});
  const [saving, setSaving] = useState(false);
  const [draftState, setDraftState] = useState<DraftState>('idle');
  const [restored, setRestored] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(() => !!(note && (note.fields.explanation || note.fields.hint || note.fields.source || note.tags.length)));
  const [conflict, setConflict] = useState<Note | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const firstRef = useRef<MarkdownEditorHandle>(null);
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

  const template: NoteTemplateDef | null = useMemo(
    () => (form.kind === 'template' ? (templates.data?.find((t) => t.id === form.templateId) ?? null) : null),
    [form.kind, form.templateId, templates.data],
  );
  // A new template note defaults to the first template.
  useEffect(() => {
    if (isNew && form.kind === 'template' && !form.templateId && pickable.length) {
      setForm((f) => ({ ...f, templateId: pickable[0].id }));
      baseline.current = { ...baseline.current, templateId: pickable[0].id };
    }
  }, [isNew, form.kind, form.templateId, pickable]);

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
      .get<{ payload: Record<string, unknown> & { baseRevision?: number }; updatedAt: string } | null>(`/api/drafts/${draftKeyAtLoad}`)
      .then((d) => {
        if (cancelled || !d?.payload) return;
        const { baseRevision, ...rest } = d.payload;
        const merged = formFromDraft(baseline.current, rest, !isNew);
        if (!same(merged, baseline.current)) {
          setForm(merged);
          setRestored(d.updatedAt);
          if (note && typeof baseRevision === 'number' && baseRevision !== note.revision) {
            // The note changed after this draft was written: saving will ask which version to keep.
            setRevision(baseRevision);
            setStaleDraft(true);
          }
          if (merged.fields.explanation || merged.fields.hint || merged.fields.source || merged.tags.length) setDetailsOpen(true);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [draftKeyAtLoad]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const setField = (k: string, v: unknown) => setForm((f) => ({ ...f, fields: { ...f.fields, [k]: v } as NoteFields }));
  const setValue = (fieldId: string, v: string) =>
    setForm((f) => ({ ...f, fields: { ...f.fields, values: { ...(f.fields as TemplateFields).values, [fieldId]: v } } as NoteFields }));

  /** Switching type on a new note keeps what can be kept (the extras, and basic text → cloze text). */
  const switchKind = (kind: NoteKind) => {
    setForm((f) => {
      const next = emptyForm(kind, f.sectionId, kind === 'template' ? (pickable[0]?.id ?? null) : null);
      const extras = { explanation: f.fields.explanation, hint: f.fields.hint, source: f.fields.source };
      let fields = { ...next.fields, ...extras } as NoteFields;
      if (kind === 'cloze' && f.kind === 'basic') fields = { ...(fields as ClozeFields), text: (f.fields as BasicFields).front };
      if (kind === 'basic' && f.kind === 'cloze') fields = { ...(fields as BasicFields), front: (f.fields as ClozeFields).text };
      return { ...next, fields, tags: f.tags, bookmarked: f.bookmarked };
    });
    setErrors({});
    setPreviewIndex(0);
  };

  // Live preview of every card the note will make.
  const preview = useMemo((): { cards: RenderedCard[]; problem: string | null } => {
    try {
      return { cards: renderNote(form.kind, form.fields, form.options, template), problem: null };
    } catch (e) {
      return { cards: [], problem: (e as Error).message };
    }
  }, [form.kind, form.fields, form.options, template]);
  const shown = preview.cards[Math.min(previewIndex, Math.max(0, preview.cards.length - 1))];

  const validate = () => {
    const e: typeof errors = {};
    if (!form.sectionId) e.section = 'Choose a section for this card.';
    if (form.kind === 'template' && !template) e.fields = 'Choose a template.';
    else {
      const problems = noteProblems(form.kind, form.fields, template);
      if (problems.length) e.fields = problems[0];
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = async (andNext: boolean, overwrite = false) => {
    if (saving || !validate()) return;
    setSaving(true);
    try {
      const pendingTags = tagPending.current.split(',').map((t) => t.trim()).filter(Boolean);
      const tags = [...form.tags, ...pendingTags.filter((t) => !form.tags.some((x) => x.toLowerCase() === t.toLowerCase()))];
      const fields = { ...form.fields, source: form.fields.source.trim() };
      let result: NoteSaveResult;
      if (isNew) {
        result = await api.post<NoteSaveResult>('/api/notes', { sectionId: form.sectionId, kind: form.kind, templateId: form.templateId, fields, options: form.options, tags, bookmarked: form.bookmarked });
      } else {
        const bookmarkChanged = form.bookmarked !== baseline.current.bookmarked;
        result = await api.patch<NoteSaveResult>(`/api/notes/${note!.id}`, {
          fields,
          options: form.options,
          tags,
          sectionId: form.sectionId,
          ...(bookmarkChanged ? { bookmarked: form.bookmarked } : {}),
          revision: overwrite ? undefined : revision,
        });
      }
      justSaved.current = true;
      pendingDraft.current = null;
      for (const k of new Set([draftKey, liveKey])) if (k) await api.del(`/api/drafts/${k}`).catch(() => undefined);
      invalidateContent();
      if (card) queryClient.removeQueries({ queryKey: ['card', card.id] });
      toast.success(syncMessage(result.sync, isNew));
      if (andNext) {
        const next: Form = { ...emptyForm(form.kind, form.sectionId, form.templateId), options: form.options, tags: form.tags };
        next.fields = { ...next.fields, source: form.fields.source } as NoteFields;
        baseline.current = next;
        setForm(next);
        setRestored(null);
        setStaleDraft(false);
        setDraftState('idle');
        setPreviewIndex(0);
        justSaved.current = false;
        requestAnimationFrame(() => firstRef.current?.focus());
      } else {
        baseline.current = form;
        navigate(`/sections/${result.note.sectionId}`);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'revision_conflict') {
        setConflict((e.details as { current?: Note })?.current ?? null);
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
    if (note) setRevision(note.revision);
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
  const KindIcon = KIND_ICON[form.kind];
  const liveCards = note?.cards.filter((c) => !c.retired) ?? [];
  const title = isNew ? `New ${form.kind === 'template' && template ? template.name : NOTE_KIND_LABEL[form.kind].toLowerCase()} note` : 'Edit card';

  return (
    <>
      <PageHeader
        docTitle={isNew ? 'New card' : 'Edit card'}
        crumbs={<Breadcrumbs crumbs={breadcrumbList} current={isNew ? 'New card' : 'Edit card'} />}
        title={isNew ? 'Create card' : title}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {!isNew && (
              <Badge icon={<KindIcon className="size-3" aria-hidden />}>
                {form.kind === 'template' && template ? template.name : NOTE_KIND_LABEL[form.kind]}
              </Badge>
            )}
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
          card &&
          note && (
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge card={card} today={today} />
              <Button
                size="sm"
                variant="ghost"
                icon={<Copy className="size-4" />}
                onClick={async () => {
                  try {
                    const r = await api.post<NoteSaveResult>(`/api/notes/${note.id}/duplicate`);
                    invalidateContent();
                    toast.success('Duplicated');
                    navigate(`/cards/${r.primaryCardId}/edit`);
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
                {card.suspendedAt ? 'Unsuspend' : liveCards.length > 1 ? 'Suspend this card' : 'Suspend'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                icon={<Trash2 className="size-4" />}
                onClick={() => h.remove('card', card.id, mdPreview(noteTitle(note.kind, note.fields, template), 80) || 'Card', () => navigate(`/sections/${card.sectionId}`))}
              >
                {liveCards.length > 1 ? 'Delete note' : 'Delete'}
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
          {card.variantLabel ? `${card.variantLabel}: next` : 'Next'} review {formatDate(card.schedule.dueDate)} · interval {plural(card.schedule.intervalDays, 'day')} · {plural(card.schedule.reviewCount, 'scheduled review')} · {plural(card.schedule.lapseCount, 'lapse')}. Editing the text keeps this history.
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
          {isNew && (
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-text-2">Card type</legend>
              <Segmented
                ariaLabel="Card type"
                value={form.kind}
                onChange={switchKind}
                options={NOTE_KINDS.map((k) => {
                  const Icon = KIND_ICON[k];
                  return { value: k, label: NOTE_KIND_LABEL[k], icon: <Icon className="size-4" aria-hidden /> };
                })}
              />
              <p className="mt-1.5 text-[13px] text-muted">{KIND_HELP[form.kind]}</p>
            </fieldset>
          )}
          {form.kind === 'template' && isNew && (
            <Field label="Template" htmlFor="card-template" hint={<Link to="/templates" className="text-primary-text hover:underline">Manage templates</Link>}>
              {pickable.length ? (
                <Select id="card-template" value={form.templateId ?? ''} onChange={(e) => setForm((f) => ({ ...f, templateId: e.target.value, fields: emptyFields('template') }))}>
                  {pickable.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <p className="text-sm text-muted">
                  No templates yet. <Link to="/templates/new" className="font-medium text-primary-text hover:underline">Create a template</Link> with your own fields and card layouts.
                </p>
              )}
            </Field>
          )}

          <Field label="Section" htmlFor="card-section" error={errors.section}>
            <SectionPicker id="card-section" value={form.sectionId} onChange={(v) => set('sectionId', v)} />
          </Field>

          {form.kind === 'basic' && (
            <>
              <MarkdownEditor ref={firstRef} id="card-front" label="Front — question" value={(form.fields as BasicFields).front} onChange={(v) => setField('front', v)} placeholder="e.g. Explain non-maximum suppression." minRows={4} onError={onError} />
              <MarkdownEditor id="card-back" label="Back — answer" value={(form.fields as BasicFields).back} onChange={(v) => setField('back', v)} placeholder="The answer. Use $$ … $$ for display equations and ``` for code." minRows={6} onError={onError} />
              <Switch
                checked={!!form.options.reverse}
                onChange={(v) => set('options', { ...form.options, reverse: v })}
                label="Also create a reverse card"
                description="Asks back → front as a separate card with its own schedule. Turning it off later keeps that card’s history."
              />
            </>
          )}

          {form.kind === 'cloze' && (
            <div className="flex flex-col gap-1.5">
              <MarkdownEditor
                ref={firstRef}
                cloze
                id="card-cloze"
                label="Text with gaps"
                value={(form.fields as ClozeFields).text}
                onChange={(v) => setField('text', v)}
                placeholder="The {{c1::mitochondrion}} is the {{c2::powerhouse::a metaphor}} of the cell."
                minRows={5}
                onError={onError}
              />
              <p className="text-[13px] text-muted">
                Select words and press <Kbd>{mod}</Kbd>
                <Kbd>⇧</Kbd>
                <Kbd>C</Kbd> (or the [..] button) to make a gap. Each number is one card; reuse a number with <Kbd>{mod}</Kbd>
                <Kbd>⌥</Kbd>
                <Kbd>⇧</Kbd>
                <Kbd>C</Kbd> to hide several parts together. Add a hint like {'{{c1::answer::hint}}'}. Gaps work inside <code>$math$</code> too.
              </p>
            </div>
          )}

          {form.kind === 'occlusion' && (
            <>
              <OcclusionEditor
                image={(form.fields as OcclusionFields).image}
                masks={(form.fields as OcclusionFields).masks}
                onImage={(url) => setField('image', url)}
                onMasks={(masks) => setField('masks', masks)}
                onError={onError}
              />
              <Field label="While answering" htmlFor="occl-mode">
                <Segmented
                  ariaLabel="Which boxes to show while answering"
                  value={form.options.occlusionMode ?? 'hide-all'}
                  onChange={(v) => set('options', { ...form.options, occlusionMode: v })}
                  options={[
                    { value: 'hide-all', label: 'Hide all boxes, ask one' },
                    { value: 'hide-one', label: 'Hide only the asked box' },
                  ]}
                />
              </Field>
              <MarkdownEditor id="card-occl-header" label="Question or context (optional)" value={(form.fields as OcclusionFields).header} onChange={(v) => setField('header', v)} placeholder="e.g. Name the labelled bones." minRows={2} onError={onError} />
            </>
          )}

          {form.kind === 'template' && template && (
            <>
              {template.fields
                .filter((f) => !f.removed)
                .map((f, i) => (
                  <MarkdownEditor
                    key={f.id}
                    ref={i === 0 ? firstRef : undefined}
                    id={`card-field-${f.id}`}
                    label={f.name}
                    value={(form.fields as TemplateFields).values[f.id] ?? ''}
                    onChange={(v) => setValue(f.id, v)}
                    minRows={3}
                    onError={onError}
                  />
                ))}
            </>
          )}

          {errors.fields && (
            <p className="-mt-2 text-sm text-danger" role="alert">
              {errors.fields}
            </p>
          )}

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
                <MarkdownEditor id="card-explanation" label="Explanation (shown after the answer)" value={form.fields.explanation} onChange={(v) => setField('explanation', v)} minRows={3} onError={onError} />
                <Field label="Hint" optional htmlFor="card-hint" hint="Hidden until you ask for it while studying.">
                  <Input id="card-hint" value={form.fields.hint} onChange={(e) => setField('hint', e.target.value)} maxLength={10000} />
                </Field>
                <Field label="Tags" optional htmlFor="card-tags" hint={preview.cards.length > 1 ? 'Tags apply to every card of this note.' : undefined}>
                  <TagInput id="card-tags" value={form.tags} onChange={(t) => set('tags', t)} pendingRef={tagPending} />
                </Field>
                <Field label="Source" optional htmlFor="card-source" hint="Free text, e.g. “Lecture 3, slide 24”.">
                  <Input id="card-source" value={form.fields.source} onChange={(e) => setField('source', e.target.value)} maxLength={500} />
                </Field>
                <Checkbox
                  checked={form.bookmarked}
                  onChange={(e) => set('bookmarked', e.target.checked)}
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <Bookmark className="size-4" aria-hidden /> {preview.cards.length > 1 ? 'Bookmark all cards of this note' : 'Bookmark this card'}
                    </span>
                  }
                />
              </div>
            )}
          </Panel>

          <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur sm:bottom-3 sm:mx-0 sm:rounded-xl sm:border sm:bg-surface sm:px-3 sm:shadow-pop sm:before:absolute sm:before:inset-x-[-2px] sm:before:bottom-full sm:before:h-4 sm:before:bg-bg sm:before:content-[''] sm:after:absolute sm:after:inset-x-[-2px] sm:after:top-full sm:after:h-3.5 sm:after:bg-bg sm:after:content-['']">
            <Button type="submit" variant="primary" loading={saving} icon={<Save className="size-4" />}>
              {isNew ? (preview.cards.length > 1 ? `Save ${preview.cards.length} cards` : 'Save card') : 'Save changes'}
            </Button>
            {isNew && (
              <Button onClick={() => save(true)} disabled={saving}>
                Save & add next
              </Button>
            )}
            <Button variant="ghost" onClick={() => navigate(form.sectionId ? `/sections/${form.sectionId}` : (-1 as never))}>
              {dirty ? 'Close (draft kept)' : 'Cancel'}
            </Button>
            <span className="ml-auto hidden items-center gap-1 text-xs text-muted md:flex">
              <Kbd>{mod}</Kbd>
              <Kbd>Enter</Kbd> save
              {isNew && (
                <>
                  {' '}
                  · <Kbd>{mod}</Kbd>
                  <Kbd>Shift</Kbd>
                  <Kbd>Enter</Kbd> save & next
                </>
              )}
            </span>
          </div>
        </div>

        <div className="min-w-0">
          <div className="sticky top-4 flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-text-2">
                Preview — as it appears when studying
                {preview.cards.length > 1 && <span className="font-normal text-muted"> · this note makes {preview.cards.length} cards</span>}
              </p>
            </div>
            {preview.cards.length > 1 && (
              <div className="flex flex-wrap gap-1" role="tablist" aria-label="Cards made by this note">
                {preview.cards.map((c, i) => (
                  <button
                    key={c.variant}
                    type="button"
                    role="tab"
                    aria-selected={i === previewIndex}
                    onClick={() => setPreviewIndex(i)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors',
                      i === previewIndex ? 'bg-primary-soft text-primary-text' : 'text-muted hover:bg-surface-2 hover:text-text',
                    )}
                  >
                    {c.label || `Card ${i + 1}`}
                  </button>
                ))}
              </div>
            )}
            {!shown ? (
              <Panel className="p-6">
                <p className="text-muted">{preview.problem ?? 'The card appears here.'}</p>
              </Panel>
            ) : (
              <>
                <Panel className="p-6">
                  <p className="mb-3 text-[13px] font-medium text-muted">Question</p>
                  <CardFace render={shown.render} front={shown.front} back={shown.back} side="front" className="text-[17px]" />
                  {form.fields.hint.trim() && (
                    <p className="mt-4 inline-flex items-center gap-1.5 text-sm text-muted">
                      <Lightbulb className="size-4" aria-hidden /> Hint available
                    </p>
                  )}
                </Panel>
                <Panel className="p-6">
                  <p className="mb-3 text-[13px] font-medium text-muted">Answer</p>
                  <CardFace render={shown.render} front={shown.front} back={shown.back} side="back" className="text-[17px]" />
                  {form.fields.explanation.trim() && (
                    <div className="mt-5 border-t border-border pt-4">
                      <p className="mb-2 text-[13px] font-medium text-muted">Explanation</p>
                      <Markdown className="text-[15px] text-text-2">{form.fields.explanation}</Markdown>
                    </div>
                  )}
                  {form.fields.source.trim() && <p className="mt-4 text-sm text-muted">Source: {form.fields.source}</p>}
                </Panel>
              </>
            )}
            {note && note.cards.length > 1 && (
              <Panel className="p-4">
                <p className="mb-2 text-sm font-medium text-text-2">Cards of this note</p>
                <ul className="flex flex-col gap-1 text-sm">
                  {note.cards.map((c) => (
                    <li key={c.id} className={cn('flex flex-wrap items-center gap-x-2', c.retired && 'text-muted')}>
                      {c.id === card?.id ? <strong className="font-medium">{c.label || 'Card'}</strong> : <Link to={`/cards/${c.id}/edit`} className="hover:underline">{c.label || 'Card'}</Link>}
                      <span className="text-muted">
                        ·{' '}
                        {c.retired
                          ? 'removed from the note — history kept, comes back if you add it again'
                          : c.suspended
                            ? 'suspended'
                            : c.dueDate
                              ? `due ${relativeDay(c.dueDate, today)}`
                              : 'new'}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
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
                  const f = fromNote(conflict);
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
            <p className="font-medium">Currently saved:</p>
            <div className="max-h-48 overflow-auto rounded-xl bg-surface-2 p-3">
              <Markdown>{noteTitle(conflict.kind, conflict.fields, template)}</Markdown>
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
