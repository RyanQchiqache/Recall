import { Archive, ArchiveRestore, ArrowDown, ArrowUp, LayoutTemplate, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { renderNote, validateTemplate, type NoteTemplateDef, type RenderedCard } from '../../shared/notes.ts';
import type { NoteTemplate, TemplateImpact } from '../../shared/types.ts';
import { Markdown } from '../components/Markdown.tsx';
import { Breadcrumbs, PageHeader } from '../components/layout/AppShell.tsx';
import { Button, IconButton, LinkButton } from '../components/ui/Button.tsx';
import { ConfirmDialog, Modal } from '../components/ui/Dialog.tsx';
import { Alert, Badge, EmptyState, ErrorState, PageLoader, Panel } from '../components/ui/Feedback.tsx';
import { Field, Input, Textarea } from '../components/ui/Form.tsx';
import { useToast } from '../components/ui/Toast.tsx';
import { ApiError, api, errorMessage } from '../lib/api.ts';
import { plural } from '../lib/format.ts';
import { invalidateContent, queryClient, useTemplate, useTemplates } from '../lib/queries.ts';
import { cn } from '../lib/util.ts';

// ---------------- List ----------------

export function TemplatesPage() {
  const templates = useTemplates(true);
  const toast = useToast();
  if (templates.isLoading) return <PageLoader />;
  if (templates.error) return <ErrorState error={templates.error} onRetry={() => templates.refetch()} />;
  const list = templates.data!;
  const setArchived = async (t: NoteTemplate, archived: boolean) => {
    try {
      await api.patch(`/api/templates/${t.id}`, { archived });
      invalidateContent();
      toast.success(archived ? `Archived “${t.name}”` : `Unarchived “${t.name}”`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <>
      <PageHeader
        title="Card templates"
        subtitle="Your own fields and card layouts, for notes you write again and again — for example vocabulary, definitions or theorems."
        actions={
          <LinkButton to="/templates/new" variant="primary" icon={<Plus className="size-4" />}>
            New template
          </LinkButton>
        }
      />
      {list.length === 0 ? (
        <EmptyState icon={<LayoutTemplate className="size-6" />} title="No templates yet" action={<LinkButton to="/templates/new" variant="primary">New template</LinkButton>}>
          A template has fields (like Term, Definition, Example) and one or more card types that arrange them, such as “Term → definition” and “Definition → term”.
        </EmptyState>
      ) : (
        <Panel as="div" className="divide-y divide-border overflow-hidden">
          {list.map((t) => (
            <div key={t.id} className={cn('flex flex-wrap items-center gap-3 px-5 py-4', t.archivedAt && 'opacity-70')}>
              <LayoutTemplate className="size-5 shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 flex-1 basis-64">
                <Link to={`/templates/${t.id}`} className="font-medium hover:underline">
                  {t.name}
                </Link>
                <p className="text-sm text-muted">
                  Fields: {t.fields.filter((f) => !f.removed).map((f) => f.name).join(', ')} · {plural(t.cards.filter((c) => !c.removed).length, 'card type')} · used by {plural(t.usage.notes, 'note')}
                </p>
              </div>
              {t.archivedAt && <Badge tone="warning">Archived</Badge>}
              <div className="flex gap-2">
                {!t.archivedAt && (
                  <LinkButton size="sm" to={`/cards/new?kind=template&template=${t.id}`} icon={<Plus className="size-4" />}>
                    New note
                  </LinkButton>
                )}
                <Button size="sm" variant="ghost" icon={t.archivedAt ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />} onClick={() => setArchived(t, !t.archivedAt)}>
                  {t.archivedAt ? 'Unarchive' : 'Archive'}
                </Button>
              </div>
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}

// ---------------- Editor ----------------

interface FieldDraft {
  key: string;
  id?: string;
  name: string;
  removed?: boolean;
}
interface CardDraft {
  key: string;
  id?: string;
  name: string;
  front: string;
  back: string;
  removed?: boolean;
}
interface Draft {
  name: string;
  fields: FieldDraft[];
  cards: CardDraft[];
}

const localKey = () => `k${Math.random().toString(36).slice(2, 10)}`;

function draftFrom(t: NoteTemplate | null): Draft {
  if (!t) {
    return {
      name: '',
      fields: [
        { key: localKey(), name: 'Front' },
        { key: localKey(), name: 'Back' },
      ],
      cards: [{ key: localKey(), name: 'Card 1', front: '{{Front}}', back: '{{FrontSide}}\n\n---\n\n{{Back}}' }],
    };
  }
  return {
    name: t.name,
    fields: t.fields.map((f) => ({ key: f.id, id: f.id, name: f.name, removed: f.removed })),
    cards: t.cards.map((c) => ({ key: c.id, id: c.id, name: c.name, front: c.front, back: c.back, removed: c.removed })),
  };
}

/** Definition with local keys as ids, for validation and preview before saving. */
function toDef(d: Draft): NoteTemplateDef {
  return {
    id: 'draft',
    name: d.name,
    revision: 0,
    fields: d.fields.map((f) => ({ id: f.key, name: f.name, removed: f.removed })),
    cards: d.cards.map((c) => ({ id: c.key, name: c.name, front: c.front, back: c.back, removed: c.removed })),
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function renamePlaceholders(text: string, from: string, to: string): string {
  if (!from || from === to) return text;
  return text.replace(new RegExp(`\\{\\{(\\s*[#^/]?\\s*)${escapeRe(from)}(\\s*)\\}\\}`, 'g'), (_m, pre: string, post: string) => `{{${pre}${to}${post}}}`);
}

export function TemplateEditorPage() {
  const { id } = useParams();
  const existing = useTemplate(id);
  if (id && existing.isLoading) return <PageLoader />;
  if (id && existing.error) return <ErrorState error={existing.error} onRetry={() => existing.refetch()} />;
  return <TemplateEditor key={id ?? 'new'} template={existing.data ?? null} />;
}

function TemplateEditor({ template }: { template: NoteTemplate | null }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [d, setD] = useState<Draft>(() => draftFrom(template));
  const [sample, setSample] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<TemplateImpact | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const nameAtFocus = useRef<{ key: string; name: string } | null>(null);
  const lastText = useRef<{ key: string; side: 'front' | 'back'; el: HTMLTextAreaElement } | null>(null);

  const def = toDef(d);
  const issues = validateTemplate(def);
  const activeFields = d.fields.filter((f) => !f.removed);
  const preview = useMemo((): { cards: RenderedCard[]; problem: string | null } => {
    const values: Record<string, string> = {};
    for (const f of def.fields) values[f.id] = sample[f.id] ?? `${f.name} example`;
    try {
      return { cards: renderNote('template', { values, explanation: '', hint: '', source: '' }, {}, def), problem: null };
    } catch (e) {
      return { cards: [], problem: (e as Error).message };
    }
  }, [JSON.stringify(def), sample]); // eslint-disable-line react-hooks/exhaustive-deps

  const setField = (key: string, patch: Partial<FieldDraft>) => setD((x) => ({ ...x, fields: x.fields.map((f) => (f.key === key ? { ...f, ...patch } : f)) }));
  const setCard = (key: string, patch: Partial<CardDraft>) => setD((x) => ({ ...x, cards: x.cards.map((c) => (c.key === key ? { ...c, ...patch } : c)) }));
  const moveField = (i: number, dir: -1 | 1) =>
    setD((x) => {
      const fields = x.fields.slice();
      const j = i + dir;
      if (j < 0 || j >= fields.length) return x;
      [fields[i], fields[j]] = [fields[j], fields[i]];
      return { ...x, fields };
    });

  /** Renaming a field updates every placeholder that uses the old name (applied when you leave the name box). */
  const commitRename = (key: string) => {
    const before = nameAtFocus.current;
    nameAtFocus.current = null;
    const now = d.fields.find((f) => f.key === key)?.name.trim() ?? '';
    if (!before || before.key !== key || !before.name || before.name === now || !now) return;
    setD((x) => ({ ...x, cards: x.cards.map((c) => ({ ...c, front: renamePlaceholders(c.front, before.name, now), back: renamePlaceholders(c.back, before.name, now) })) }));
  };

  const insertField = (name: string) => {
    const t = lastText.current;
    if (!t) return;
    const token = `{{${name}}}`;
    const el = t.el;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const card = d.cards.find((c) => c.key === t.key);
    if (!card) return;
    const value = card[t.side];
    setCard(t.key, { [t.side]: value.slice(0, start) + token + value.slice(end) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const body = () => ({
    name: d.name,
    revision: template?.revision,
    fields: d.fields.map((f) => ({ ...(f.id ? { id: f.id } : {}), name: f.name, removed: f.removed })),
    cards: d.cards.map((c) => ({ ...(c.id ? { id: c.id } : {}), name: c.name, front: c.front, back: c.back, removed: c.removed })),
  });

  const save = async () => {
    setError(null);
    if (issues.length) {
      setError(issues[0].message);
      return;
    }
    setSaving(true);
    try {
      if (!template) {
        const created = await api.post<NoteTemplate>('/api/templates', body());
        invalidateContent();
        toast.success('Template created');
        navigate(`/templates/${created.id}`, { replace: true });
        return;
      }
      const dry = await api.patch<{ impact: TemplateImpact }>(`/api/templates/${template.id}?dryRun=1`, body());
      const i = dry.impact;
      if (i.notes > 0 && (i.created || i.retired || i.restored || i.notesWithoutCards || i.updated)) {
        setImpact(i);
        return;
      }
      await apply();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const apply = async () => {
    if (!template) return;
    setSaving(true);
    try {
      const r = await api.patch<{ template: NoteTemplate; impact: TemplateImpact }>(`/api/templates/${template.id}`, body());
      invalidateContent();
      queryClient.setQueryData(['template', template.id], r.template);
      setD(draftFrom(r.template));
      setImpact(null);
      toast.success(r.impact.notes ? `Template saved and applied to ${plural(r.impact.notes, 'note')}` : 'Template saved');
    } catch (e) {
      setError(errorMessage(e));
      setImpact(null);
    } finally {
      setSaving(false);
    }
  };

  const inUse = template?.usage.notes ?? 0;
  return (
    <>
      <PageHeader
        docTitle={template ? template.name : 'New template'}
        crumbs={<Breadcrumbs crumbs={[]} current={template ? template.name : 'New template'} />}
        title={template ? 'Edit template' : 'New template'}
        subtitle={
          template ? (
            <span>
              Used by {plural(inUse, 'note')} ({plural(template.usage.cards, 'card')}). <Link to="/templates" className="text-primary-text hover:underline">All templates</Link>
            </span>
          ) : (
            <Link to="/templates" className="text-primary-text hover:underline">All templates</Link>
          )
        }
        actions={
          <>
            {template && inUse === 0 && (
              <Button variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => setDeleteOpen(true)}>
                Delete
              </Button>
            )}
            {template && !template.archivedAt && (
              <LinkButton to={`/cards/new?kind=template&template=${template.id}`} icon={<Plus className="size-4" />}>
                New note
              </LinkButton>
            )}
            <Button variant="primary" icon={<Save className="size-4" />} loading={saving} onClick={save}>
              {template ? 'Save template' : 'Create template'}
            </Button>
          </>
        }
      />
      {error && (
        <Alert tone="danger" className="mb-5">
          {error}
        </Alert>
      )}
      {template && inUse > 0 && (
        <Alert tone="info" className="mb-5" title="Changes apply to existing notes">
          Saving shows exactly how many cards will be added, updated or set aside first. Renaming keeps every note’s text. Removing a field or card type hides it but keeps its values and card history, so you can restore it.
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[1.15fr_1fr]">
        <div className="flex min-w-0 flex-col gap-5">
          <Field label="Template name" htmlFor="tpl-name">
            <Input id="tpl-name" value={d.name} maxLength={120} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. Vocabulary, Theorem, Algorithm" />
          </Field>

          <Panel className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="font-semibold">Fields</h2>
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setD({ ...d, fields: [...d.fields, { key: localKey(), name: `Field ${d.fields.length + 1}` }] })}>
                Add field
              </Button>
            </div>
            <ul className="flex flex-col gap-2">
              {d.fields.map((f, i) => (
                <li key={f.key} className={cn('flex items-center gap-2', f.removed && 'opacity-60')}>
                  <Input
                    aria-label={`Name of field ${i + 1}`}
                    value={f.name}
                    disabled={f.removed}
                    maxLength={80}
                    onFocus={() => (nameAtFocus.current = { key: f.key, name: f.name.trim() })}
                    onBlur={() => commitRename(f.key)}
                    onChange={(e) => setField(f.key, { name: e.target.value })}
                  />
                  <IconButton size="sm" label="Move field up" onClick={() => moveField(i, -1)} disabled={i === 0}>
                    <ArrowUp className="size-4" />
                  </IconButton>
                  <IconButton size="sm" label="Move field down" onClick={() => moveField(i, 1)} disabled={i === d.fields.length - 1}>
                    <ArrowDown className="size-4" />
                  </IconButton>
                  {f.removed ? (
                    <IconButton size="sm" label={`Restore field ${f.name}`} onClick={() => setField(f.key, { removed: false })}>
                      <RotateCcw className="size-4" />
                    </IconButton>
                  ) : f.id ? (
                    <IconButton size="sm" label={`Remove field ${f.name} (its values are kept)`} onClick={() => setField(f.key, { removed: true })} disabled={activeFields.length <= 1}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  ) : (
                    <IconButton size="sm" label={`Delete field ${f.name}`} onClick={() => setD({ ...d, fields: d.fields.filter((x) => x.key !== f.key) })} disabled={activeFields.length <= 1}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[13px] text-muted">The order here is the order of the inputs in the card editor.</p>
          </Panel>

          <Panel className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="font-semibold">Card types</h2>
              <Button
                size="sm"
                icon={<Plus className="size-4" />}
                onClick={() => setD({ ...d, cards: [...d.cards, { key: localKey(), name: `Card ${d.cards.length + 1}`, front: activeFields[1] ? `{{${activeFields[1].name}}}` : '', back: `{{${activeFields[0]?.name ?? ''}}}` }] })}
              >
                Add card type
              </Button>
            </div>
            <p className="mb-3 text-[13px] text-muted">
              Each card type becomes one card per note. Use <code>{'{{Field}}'}</code> for a value, <code>{'{{#Field}}…{{/Field}}'}</code> to show something only when the field is filled, and <code>{'{{FrontSide}}'}</code> on the back to repeat the question. A card is only made when a field on its front has content.
            </p>
            <div className="mb-3 flex flex-wrap items-center gap-1.5" aria-label="Insert a field into the box you edited last">
              <span className="text-[13px] text-muted">Insert:</span>
              {activeFields.map((f) => (
                <button key={f.key} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertField(f.name)} className="rounded-md border border-border px-2 py-0.5 font-mono text-[12px] text-text-2 hover:border-border-strong hover:text-text">
                  {`{{${f.name}}}`}
                </button>
              ))}
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertField('FrontSide')} className="rounded-md border border-border px-2 py-0.5 font-mono text-[12px] text-text-2 hover:border-border-strong hover:text-text">
                {'{{FrontSide}}'}
              </button>
            </div>
            <div className="flex flex-col gap-4">
              {d.cards.map((c, i) => (
                <div key={c.key} className={cn('rounded-xl border border-border p-4', c.removed && 'opacity-60')}>
                  <div className="mb-3 flex items-center gap-2">
                    <Input aria-label={`Name of card type ${i + 1}`} value={c.name} disabled={c.removed} maxLength={80} onChange={(e) => setCard(c.key, { name: e.target.value })} />
                    {c.removed ? (
                      <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => setCard(c.key, { removed: false })}>
                        Restore
                      </Button>
                    ) : c.id ? (
                      <IconButton size="sm" label={`Remove card type ${c.name} (its cards keep their history)`} onClick={() => setCard(c.key, { removed: true })} disabled={d.cards.filter((x) => !x.removed).length <= 1}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    ) : (
                      <IconButton size="sm" label={`Delete card type ${c.name}`} onClick={() => setD({ ...d, cards: d.cards.filter((x) => x.key !== c.key) })} disabled={d.cards.filter((x) => !x.removed).length <= 1}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    )}
                  </div>
                  {c.removed ? (
                    <p className="text-sm text-muted">Removed — its cards are hidden but keep their history. Restore to bring them back.</p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(['front', 'back'] as const).map((side) => (
                        <Field key={side} label={side === 'front' ? 'Front' : 'Back'} htmlFor={`tpl-${c.key}-${side}`}>
                          <Textarea
                            id={`tpl-${c.key}-${side}`}
                            value={c[side]}
                            rows={4}
                            className="font-mono text-[13px]"
                            onFocus={(e) => (lastText.current = { key: c.key, side, el: e.currentTarget })}
                            onChange={(e) => setCard(c.key, { [side]: e.target.value })}
                          />
                        </Field>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Panel>
          {issues.length > 0 && (
            <Alert tone="warning" title="Fix these before saving">
              <ul className="list-disc pl-5">
                {[...new Set(issues.map((x) => x.message))].slice(0, 6).map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </Alert>
          )}
        </div>

        <div className="min-w-0">
          <div className="sticky top-4 flex flex-col gap-4">
            <Panel className="p-5">
              <h2 className="mb-3 font-semibold">Preview with sample values</h2>
              <div className="mb-4 grid gap-2">
                {activeFields.map((f) => (
                  <Input key={f.key} aria-label={`Sample value for ${f.name}`} placeholder={`${f.name} example`} value={sample[f.key] ?? ''} onChange={(e) => setSample({ ...sample, [f.key]: e.target.value })} />
                ))}
              </div>
              {preview.problem && <p className="text-sm text-muted">{preview.problem}</p>}
              <div className="flex flex-col gap-3">
                {preview.cards.map((card) => (
                  <div key={card.variant} className="rounded-xl border border-border p-4">
                    <p className="mb-2 text-[13px] font-medium text-muted">{card.label}</p>
                    <Markdown className="text-[15px]">{card.front}</Markdown>
                    <div className="my-3 border-t border-dashed border-border" />
                    <Markdown className="text-[15px] text-text-2">{card.back}</Markdown>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </div>
      </div>

      {impact && (
        <Modal
          open
          onOpenChange={(o) => !o && setImpact(null)}
          title="Apply this change to existing notes?"
          footer={
            <>
              <Button onClick={() => setImpact(null)}>Cancel</Button>
              <Button variant="primary" loading={saving} onClick={apply}>
                Apply to {plural(impact.notes, 'note')}
              </Button>
            </>
          }
        >
          <ul className="flex flex-col gap-1.5 text-[15px]">
            {impact.created > 0 && <li>{plural(impact.created, 'new card')} will be created (they start as new).</li>}
            {impact.updated > 0 && <li>{plural(impact.updated, 'card')} will show the updated layout; their schedules stay.</li>}
            {impact.retired > 0 && <li>{plural(impact.retired, 'card')} will be set aside. Their history is kept and they return if you restore the card type.</li>}
            {impact.restored > 0 && <li>{plural(impact.restored, 'card')} will come back with their history.</li>}
          </ul>
          {impact.notesWithoutCards > 0 && (
            <Alert tone="warning" className="mt-3">
              {plural(impact.notesWithoutCards, 'note')} would no longer fill any card front, so all their cards are set aside until you fill the fields those fronts use.
            </Alert>
          )}
        </Modal>
      )}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this template?"
        tone="danger"
        confirmLabel="Delete template"
        onConfirm={async () => {
          try {
            await api.del(`/api/templates/${template!.id}`);
            invalidateContent();
            toast.success('Template deleted');
            navigate('/templates');
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      >
        No notes use it, so nothing else changes.
      </ConfirmDialog>
    </>
  );
}
