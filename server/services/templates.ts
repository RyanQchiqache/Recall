/**
 * Reusable note templates with explicit fields and card types.
 *
 * Safe evolution:
 *  - fields and card types have permanent ids; renaming never touches note values;
 *  - an existing field or card type is never hard-deleted — "remove" marks it removed,
 *    so its values and its cards' history survive and it can be restored;
 *  - every change is previewed (dry run in a rolled-back transaction) with the exact
 *    number of cards that will be created, updated, retired and restored, then applied
 *    to all notes of the template in one transaction.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { validateTemplate, type NoteTemplateDef, type TemplateCardType, type TemplateField } from '../../shared/notes.ts';
import type { NoteTemplate, TemplateImpact } from '../../shared/types.ts';
import { nowIso, type Ctx } from '../context.ts';
import { AppError, badRequest, conflict, newId, notFound, parseJson } from '../lib/util.ts';
import { parse } from '../lib/validate.ts';
import { resyncNote, type NoteRow } from './notes.ts';

interface TemplateRow {
  id: string;
  name: string;
  fields_json: string;
  cards_json: string;
  revision: number;
  is_demo: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const shortId = () => crypto.randomBytes(6).toString('base64url');

const zDef = z.object({
  name: z.string().trim().min(1, 'Give the template a name').max(120),
  fields: z
    .array(z.object({ id: z.string().max(40).optional(), name: z.string().trim().max(80), removed: z.boolean().optional() }))
    .min(1)
    .max(40),
  cards: z
    .array(
      z.object({
        id: z.string().max(40).optional(),
        name: z.string().trim().max(80),
        front: z.string().max(50_000),
        back: z.string().max(50_000),
        removed: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(20),
});

function toDef(r: TemplateRow): NoteTemplateDef {
  return {
    id: r.id,
    name: r.name,
    fields: parseJson<TemplateField[]>(r.fields_json, []),
    cards: parseJson<TemplateCardType[]>(r.cards_json, []),
    revision: r.revision,
  };
}

function getRowById(ctx: Ctx, id: string): TemplateRow {
  const row = ctx.db.prepare('SELECT * FROM note_templates WHERE id = ?').get(id) as TemplateRow | undefined;
  if (!row) throw notFound('Template');
  return row;
}

export function getTemplateDef(ctx: Ctx, id: string): NoteTemplateDef {
  return toDef(getRowById(ctx, id));
}

function noteCount(ctx: Ctx, id: string): { notes: number; cards: number } {
  const n = ctx.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE template_id = ? AND deleted_at IS NULL').get(id) as { n: number };
  const c = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM cards c JOIN notes n ON n.id = c.note_id WHERE n.template_id = ? AND c.deleted_at IS NULL')
    .get(id) as { n: number };
  return { notes: n.n, cards: c.n };
}

function toDto(ctx: Ctx, r: TemplateRow): NoteTemplate {
  return { ...toDef(r), isDemo: r.is_demo === 1, archivedAt: r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at, usage: noteCount(ctx, r.id) };
}

export function listTemplates(ctx: Ctx, opts: { includeArchived?: boolean } = {}): NoteTemplate[] {
  const rows = ctx.db
    .prepare(`SELECT * FROM note_templates ${opts.includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY name COLLATE NOCASE`)
    .all() as TemplateRow[];
  return rows.map((r) => toDto(ctx, r));
}

export function getTemplate(ctx: Ctx, id: string): NoteTemplate {
  return toDto(ctx, getRowById(ctx, id));
}

function assertValid(def: Pick<NoteTemplateDef, 'name' | 'fields' | 'cards'>) {
  const issues = validateTemplate(def);
  if (issues.length) throw new AppError(400, 'invalid_template', issues[0].message, { issues });
}

export function createTemplate(ctx: Ctx, input: unknown, opts: { isDemo?: boolean } = {}): NoteTemplate {
  const data = parse(zDef, input);
  const def = {
    name: data.name,
    fields: data.fields.filter((f) => !f.removed).map((f) => ({ id: shortId(), name: f.name })),
    cards: data.cards.filter((c) => !c.removed).map((c) => ({ id: shortId(), name: c.name, front: c.front, back: c.back })),
  };
  assertValid(def);
  const id = newId(ctx.now().getTime());
  const ts = nowIso(ctx);
  ctx.db
    .prepare('INSERT INTO note_templates (id, name, fields_json, cards_json, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, def.name, JSON.stringify(def.fields), JSON.stringify(def.cards), opts.isDemo ? 1 : 0, ts, ts);
  return getTemplate(ctx, id);
}

/** Merge the requested definition with the stored one so existing ids are never lost. */
function mergeDefinition(current: NoteTemplateDef, data: z.infer<typeof zDef>): Pick<NoteTemplateDef, 'name' | 'fields' | 'cards'> {
  const knownFields = new Map(current.fields.map((f) => [f.id, f]));
  const fields: TemplateField[] = data.fields.map((f) => (f.id && knownFields.has(f.id) ? { id: f.id, name: f.name, removed: f.removed || undefined } : { id: shortId(), name: f.name, removed: f.removed || undefined }));
  for (const f of current.fields) if (!fields.some((x) => x.id === f.id)) fields.push({ ...f, removed: true });
  const knownCards = new Map(current.cards.map((c) => [c.id, c]));
  const cards: TemplateCardType[] = data.cards.map((c) => ({
    id: c.id && knownCards.has(c.id) ? c.id : shortId(),
    name: c.name,
    front: c.front,
    back: c.back,
    removed: c.removed || undefined,
  }));
  for (const c of current.cards) if (!cards.some((x) => x.id === c.id)) cards.push({ ...c, removed: true });
  return { name: data.name, fields: fields.map(clean), cards: cards.map(clean) };
}

function clean<T extends { removed?: boolean }>(x: T): T {
  if (!x.removed) delete x.removed;
  return x;
}

class DryRun extends Error {}

/**
 * Preview (dryRun) or apply a template change. The preview runs the real update inside a
 * transaction that is rolled back, so its numbers are exactly what applying would do.
 */
export function updateTemplate(ctx: Ctx, id: string, input: unknown, opts: { dryRun?: boolean } = {}): { template: NoteTemplate; impact: TemplateImpact } {
  const body = (input ?? {}) as Record<string, unknown>;
  const row = getRowById(ctx, id);
  if (typeof body.revision === 'number' && body.revision !== row.revision) {
    throw conflict('revision_conflict', 'This template was changed elsewhere. Reload it before saving.');
  }
  if (typeof body.archived === 'boolean' && body.fields === undefined) {
    ctx.db.prepare('UPDATE note_templates SET archived_at = ?, updated_at = ? WHERE id = ?').run(body.archived ? nowIso(ctx) : null, nowIso(ctx), id);
    return { template: getTemplate(ctx, id), impact: emptyImpact() };
  }
  const data = parse(zDef, input);
  const next = mergeDefinition(toDef(row), data);
  assertValid(next);
  const impact = emptyImpact();
  const run = ctx.db.transaction(() => {
    const ts = nowIso(ctx);
    ctx.db
      .prepare('UPDATE note_templates SET name = ?, fields_json = ?, cards_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(next.name, JSON.stringify(next.fields), JSON.stringify(next.cards), ts, id);
    const def = getTemplateDef(ctx, id);
    const notes = ctx.db.prepare('SELECT * FROM notes WHERE template_id = ?').all(id) as NoteRow[];
    for (const n of notes) {
      const r = resyncNote(ctx, n, def);
      impact.notes++;
      impact.created += r.created;
      impact.updated += r.updated;
      impact.retired += r.retired;
      impact.restored += r.restored;
      if (r.error) impact.notesWithoutCards++;
    }
    if (opts.dryRun) throw new DryRun();
  });
  try {
    run();
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
  return { template: opts.dryRun ? { ...getTemplate(ctx, id), ...next } : getTemplate(ctx, id), impact };
}

function emptyImpact(): TemplateImpact {
  return { notes: 0, created: 0, updated: 0, retired: 0, restored: 0, notesWithoutCards: 0 };
}

/** Delete an unused template. A template that notes still use can only be archived. */
export function deleteTemplate(ctx: Ctx, id: string) {
  getRowById(ctx, id);
  const used = ctx.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE template_id = ?').get(id) as { n: number };
  if (used.n > 0) {
    throw conflict('template_in_use', `${used.n} note(s) use this template, including any in the trash. Archive it instead, or delete those notes permanently first.`);
  }
  ctx.db.prepare('DELETE FROM note_templates WHERE id = ?').run(id);
}

export function assertTemplateUsable(ctx: Ctx, id: string) {
  const row = getRowById(ctx, id);
  if (row.archived_at) throw badRequest('This template is archived. Unarchive it to add new notes with it.');
}
