/**
 * Notes own the written content; cards are what gets scheduled.
 *
 * syncNoteCards() is the only place that turns a note into card rows. It matches the
 * rendered cards to existing rows by their permanent variant key, so:
 *  - edits keep each card's schedule and review history;
 *  - a variant that disappears (a removed cloze gap, box or card type, or reverse turned
 *    off) is *retired*: hidden everywhere but kept, and restored with its history if
 *    the same variant comes back.
 *
 * Invariants kept here:
 *  - all cards of a note share section_id, position and tags;
 *  - note.deleted_at set  ⇒  every card of the note has deleted_at set;
 *  - a retired card has retired_at and deleted_at set.
 */
import { z } from 'zod';
import {
  emptyFields,
  NOTE_KINDS,
  NoteError,
  noteTitle,
  renderNote,
  type NoteFields,
  type NoteKind,
  type NoteOptions,
  type NoteTemplateDef,
  type RenderedCard,
} from '../../shared/notes.ts';
import type { Note, NoteCardSummary } from '../../shared/types.ts';
import { nowIso, type Ctx } from '../context.ts';
import { AppError, badRequest, conflict, newId, notFound, parseJson } from '../lib/util.ts';
import { parse, zId } from '../lib/validate.ts';
import { getRow, itemState, removeOrphanTags } from './hierarchy.ts';
import { cardStatus } from './mappers.ts';
import { assertTemplateUsable, getTemplateDef } from './templates.ts';
import { today } from './time.ts';

export interface NoteRow {
  id: string;
  section_id: string;
  kind: NoteKind;
  template_id: string | null;
  fields_json: string;
  options_json: string;
  position: number;
  revision: number;
  is_demo: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CardRowLite {
  id: string;
  variant: string;
  front: string;
  back: string;
  explanation: string;
  hint: string;
  source: string;
  variant_order: number;
  variant_label: string;
  render_json: string;
  retired_at: string | null;
  deleted_at: string | null;
  bookmarked: number;
}

// ---------- Validation ----------

const zTag = z
  .string()
  .trim()
  .min(1)
  .max(60, 'Tags must be at most 60 characters')
  .refine((t) => !/[,\u001f]/.test(t), 'Tags cannot contain commas');
const zText = (max: number) => z.string().max(max);
const zExtras = {
  explanation: zText(200_000).default(''),
  hint: zText(10_000).default(''),
  source: zText(500).default(''),
};
const zMask = z.object({
  id: z.string().min(4).max(40),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  label: zText(200).default(''),
});
const zFields = {
  basic: z.object({ front: zText(200_000).default(''), back: zText(200_000).default(''), ...zExtras }),
  cloze: z.object({ text: zText(200_000).default(''), ...zExtras }),
  occlusion: z.object({ image: zText(200).default(''), header: zText(20_000).default(''), masks: z.array(zMask).max(200).default([]), ...zExtras }),
  template: z.object({ values: z.record(z.string().max(64), zText(200_000)).default({}), ...zExtras }),
};
const zOptions = z
  .object({ reverse: z.boolean().optional(), occlusionMode: z.enum(['hide-all', 'hide-one']).optional() })
  .default({});

const noteCreate = z.object({
  sectionId: zId,
  kind: z.enum(NOTE_KINDS).default('basic'),
  templateId: zId.nullable().optional(),
  fields: z.record(z.string(), z.unknown()),
  options: zOptions,
  tags: z.array(zTag).max(50).default([]),
  bookmarked: z.boolean().optional(),
});
const noteUpdate = z.object({
  sectionId: zId.optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  options: zOptions.optional(),
  tags: z.array(zTag).max(50).optional(),
  bookmarked: z.boolean().optional(),
  revision: z.number().int().positive().optional(),
});

export function parseFields(kind: NoteKind, raw: unknown): NoteFields {
  return parse(zFields[kind] as z.ZodType<NoteFields>, raw ?? {});
}

function normalizeOptions(kind: NoteKind, o: NoteOptions): NoteOptions {
  if (kind === 'basic') return o.reverse ? { reverse: true } : {};
  if (kind === 'occlusion') return { occlusionMode: o.occlusionMode === 'hide-one' ? 'hide-one' : 'hide-all' };
  return {};
}

export function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Map<string, string>();
  for (const t of tags) {
    const clean = t.trim().replace(/\s+/g, ' ');
    if (clean && !seen.has(clean.toLowerCase())) seen.set(clean.toLowerCase(), clean);
  }
  return [...seen.values()];
}

// ---------- Reads ----------

export function getNoteRow(ctx: Ctx, id: string): NoteRow {
  const row = ctx.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
  if (!row) throw notFound('Note');
  return row;
}

export function noteIdOfCard(ctx: Ctx, cardId: string): string {
  const row = ctx.db.prepare('SELECT note_id FROM cards WHERE id = ?').get(cardId) as { note_id: string | null } | undefined;
  if (!row?.note_id) throw notFound('Card');
  return row.note_id;
}

export function noteFields(row: NoteRow): NoteFields {
  return { ...emptyFields(row.kind), ...parseJson<Record<string, unknown>>(row.fields_json, {}) } as NoteFields;
}

export function noteOptions(row: NoteRow): NoteOptions {
  return parseJson<NoteOptions>(row.options_json, {});
}

function noteTags(ctx: Ctx, noteId: string): string[] {
  const rows = ctx.db
    .prepare(
      `SELECT DISTINCT t.name FROM card_tags ct JOIN tags t ON t.id = ct.tag_id
       WHERE ct.card_id = (SELECT id FROM cards WHERE note_id = ? ORDER BY retired_at IS NOT NULL, variant_order LIMIT 1)
       ORDER BY t.name COLLATE NOCASE`,
    )
    .all(noteId) as { name: string }[];
  return rows.map((r) => r.name);
}

export function getNote(ctx: Ctx, id: string): Note {
  const row = getNoteRow(ctx, id);
  if (row.deleted_at) throw notFound('Note');
  const day = today(ctx);
  const cards = ctx.db
    .prepare(
      `SELECT c.id, c.variant, c.variant_label, c.variant_order, c.retired_at, c.suspended_at, c.bookmarked,
              cs.due_date, cs.review_count
       FROM cards c LEFT JOIN card_schedules cs ON cs.card_id = c.id
       WHERE c.note_id = ? ORDER BY c.retired_at IS NOT NULL, c.variant_order`,
    )
    .all(id) as {
    id: string;
    variant: string;
    variant_label: string;
    retired_at: string | null;
    suspended_at: string | null;
    bookmarked: number;
    due_date: string | null;
    review_count: number | null;
  }[];
  const summaries: NoteCardSummary[] = cards.map((c) => ({
    id: c.id,
    variant: c.variant,
    label: c.variant_label,
    status: cardStatus(c.suspended_at !== null, c.due_date, day),
    dueDate: c.due_date,
    reviewCount: c.review_count ?? 0,
    retired: c.retired_at !== null,
    suspended: c.suspended_at !== null,
  }));
  const live = cards.filter((c) => !c.retired_at);
  return {
    id: row.id,
    sectionId: row.section_id,
    kind: row.kind,
    templateId: row.template_id,
    fields: noteFields(row),
    options: noteOptions(row),
    tags: noteTags(ctx, id),
    bookmarked: live.length > 0 && live.every((c) => c.bookmarked === 1),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cards: summaries,
  };
}

/** The first live card of a note (what lists and the legacy card API treat as "the" card). */
export function primaryCardId(ctx: Ctx, noteId: string): string {
  const row = ctx.db
    .prepare('SELECT id FROM cards WHERE note_id = ? ORDER BY retired_at IS NOT NULL, variant_order LIMIT 1')
    .get(noteId) as { id: string } | undefined;
  if (!row) throw notFound('Card');
  return row.id;
}

// ---------- Rendering & syncing ----------

function assertSectionWritable(ctx: Ctx, sectionId: string) {
  getRow(ctx, 'section', sectionId);
  if (itemState(ctx, 'section', sectionId).inTrash) throw badRequest('That section is in the trash');
}

export function nextNotePosition(ctx: Ctx, sectionId: string): number {
  const r = ctx.db.prepare('SELECT MAX(position) AS m FROM notes WHERE section_id = ?').get(sectionId) as { m: number | null };
  return (r.m ?? -1) + 1;
}

/** Render, translating content problems into a 400 with the shared plain-language message. */
export function renderOrThrow(kind: NoteKind, fields: NoteFields, options: NoteOptions, template: NoteTemplateDef | null): RenderedCard[] {
  try {
    return renderNote(kind, fields, options, template);
  } catch (e) {
    if (e instanceof NoteError) throw badRequest(e.message);
    throw e;
  }
}

export interface SyncResult {
  created: number;
  updated: number;
  retired: number;
  restored: number;
}

export function setCardTags(ctx: Ctx, cardId: string, tags: string[]) {
  const db = ctx.db;
  db.prepare('DELETE FROM card_tags WHERE card_id = ?').run(cardId);
  for (const name of normalizeTags(tags)) {
    let tag = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(name) as { id: string } | undefined;
    if (!tag) {
      tag = { id: newId(ctx.now().getTime()) };
      db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)').run(tag.id, name, nowIso(ctx));
    }
    db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)').run(cardId, tag.id);
  }
}

/**
 * Bring a note's card rows in line with what it renders to. Must run inside a transaction.
 * `tags` replaces the tags of every live card; when omitted, new cards copy the current tags.
 */
export function syncNoteCards(
  ctx: Ctx,
  note: NoteRow,
  rendered: RenderedCard[],
  opts: { tags?: string[]; bookmarked?: boolean } = {},
): SyncResult {
  const db = ctx.db;
  const ts = nowIso(ctx);
  const fields = noteFields(note);
  const existing = db.prepare('SELECT * FROM cards WHERE note_id = ?').all(note.id) as CardRowLite[];
  const byVariant = new Map(existing.map((c) => [c.variant, c]));
  const tags = opts.tags ?? noteTags(ctx, note.id);
  const firstLive = existing.find((c) => !c.retired_at);
  const defaultBookmark = opts.bookmarked ?? (firstLive ? firstLive.bookmarked === 1 : false);
  const result: SyncResult = { created: 0, updated: 0, retired: 0, restored: 0 };
  const seen = new Set<string>();
  const deletedAt = note.deleted_at;

  for (const r of rendered) {
    seen.add(r.variant);
    const renderJson = JSON.stringify(r.render);
    const ex = byVariant.get(r.variant);
    if (ex) {
      const changed =
        ex.front !== r.front ||
        ex.back !== r.back ||
        ex.explanation !== fields.explanation ||
        ex.hint !== fields.hint ||
        ex.source !== fields.source.trim() ||
        ex.render_json !== renderJson ||
        ex.variant_label !== r.label;
      const wasRetired = ex.retired_at !== null;
      db.prepare(
        `UPDATE cards SET section_id = ?, front = ?, back = ?, explanation = ?, hint = ?, source = ?, position = ?,
           variant_order = ?, variant_label = ?, render_json = ?, retired_at = NULL, deleted_at = ?,
           bookmarked = CASE WHEN ? IS NULL THEN bookmarked ELSE ? END,
           revision = revision + ?, updated_at = CASE WHEN ? THEN ? ELSE updated_at END
         WHERE id = ?`,
      ).run(
        note.section_id,
        r.front,
        r.back,
        fields.explanation,
        fields.hint,
        fields.source.trim(),
        note.position,
        r.order,
        r.label,
        renderJson,
        deletedAt,
        opts.bookmarked === undefined ? null : 1,
        opts.bookmarked ? 1 : 0,
        changed ? 1 : 0,
        changed || wasRetired ? 1 : 0,
        ts,
        ex.id,
      );
      if (wasRetired) result.restored++;
      else if (changed) result.updated++;
      if (opts.tags || wasRetired) setCardTags(ctx, ex.id, tags);
    } else {
      const id = newId(ctx.now().getTime());
      db.prepare(
        `INSERT INTO cards (id, note_id, section_id, variant, variant_order, variant_label, render_json, front, back, explanation, hint, source,
           bookmarked, position, is_demo, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        note.id,
        note.section_id,
        r.variant,
        r.order,
        r.label,
        renderJson,
        r.front,
        r.back,
        fields.explanation,
        fields.hint,
        fields.source.trim(),
        defaultBookmark ? 1 : 0,
        note.position,
        note.is_demo,
        deletedAt,
        ts,
        ts,
      );
      setCardTags(ctx, id, tags);
      result.created++;
    }
  }
  for (const ex of existing) {
    if (seen.has(ex.variant)) continue;
    if (!ex.retired_at) {
      db.prepare('UPDATE cards SET retired_at = ?, deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, ts, ex.id);
      result.retired++;
    } else {
      // Keep retired cards with the note's section and position.
      db.prepare('UPDATE cards SET section_id = ?, position = ? WHERE id = ?').run(note.section_id, note.position, ex.id);
    }
  }
  if (opts.tags) removeOrphanTags(ctx);
  return result;
}

// ---------- Writes ----------

export function createNote(ctx: Ctx, input: unknown, opts: { isDemo?: boolean } = {}): { note: Note; sync: SyncResult } {
  const data = parse(noteCreate, input);
  assertSectionWritable(ctx, data.sectionId);
  const kind = data.kind;
  let template: NoteTemplateDef | null = null;
  if (kind === 'template') {
    if (!data.templateId) throw badRequest('Choose a template for this note');
    assertTemplateUsable(ctx, data.templateId);
    template = getTemplateDef(ctx, data.templateId);
  }
  const fields = parseFields(kind, data.fields);
  const options = normalizeOptions(kind, data.options);
  const rendered = renderOrThrow(kind, fields, options, template);
  const id = newId(ctx.now().getTime());
  const ts = nowIso(ctx);
  let sync: SyncResult = { created: 0, updated: 0, retired: 0, restored: 0 };
  ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `INSERT INTO notes (id, section_id, kind, template_id, fields_json, options_json, position, is_demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, data.sectionId, kind, kind === 'template' ? data.templateId : null, JSON.stringify(fields), JSON.stringify(options), nextNotePosition(ctx, data.sectionId), opts.isDemo ? 1 : 0, ts, ts);
    sync = syncNoteCards(ctx, getNoteRow(ctx, id), rendered, { tags: normalizeTags(data.tags), bookmarked: data.bookmarked ?? false });
  })();
  return { note: getNote(ctx, id), sync };
}

export function updateNote(ctx: Ctx, id: string, input: unknown, opts: { skipRevisionCheck?: boolean } = {}): { note: Note; sync: SyncResult } {
  const data = parse(noteUpdate, input);
  const row = getNoteRow(ctx, id);
  if (row.deleted_at) throw notFound('Note');
  if (itemState(ctx, 'section', row.section_id).inTrash) {
    throw badRequest('This card’s section is in the trash. Restore it before editing the card.');
  }
  if (!opts.skipRevisionCheck && data.revision !== undefined && data.revision !== row.revision) {
    throw conflict('revision_conflict', 'This card was changed elsewhere since you opened it.', { current: getNote(ctx, id) });
  }
  if (data.sectionId && data.sectionId !== row.section_id) assertSectionWritable(ctx, data.sectionId);
  const template = row.kind === 'template' ? getTemplateDef(ctx, row.template_id!) : null;
  const fields = data.fields ? parseFields(row.kind, { ...noteFields(row), ...data.fields }) : noteFields(row);
  const options = data.options ? normalizeOptions(row.kind, data.options) : noteOptions(row);
  const rendered = renderOrThrow(row.kind, fields, options, template);
  const ts = nowIso(ctx);
  let sync: SyncResult = { created: 0, updated: 0, retired: 0, restored: 0 };
  ctx.db.transaction(() => {
    const moving = data.sectionId && data.sectionId !== row.section_id;
    ctx.db
      .prepare(
        `UPDATE notes SET section_id = ?, position = ?, fields_json = ?, options_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
      )
      .run(moving ? data.sectionId : row.section_id, moving ? nextNotePosition(ctx, data.sectionId!) : row.position, JSON.stringify(fields), JSON.stringify(options), ts, id);
    sync = syncNoteCards(ctx, getNoteRow(ctx, id), rendered, { tags: data.tags ? normalizeTags(data.tags) : undefined, bookmarked: data.bookmarked });
  })();
  return { note: getNote(ctx, id), sync };
}

/** Re-render a note after its template changed (no revision check; runs inside the caller's transaction). */
export function resyncNote(ctx: Ctx, row: NoteRow, template: NoteTemplateDef | null): SyncResult & { error?: string } {
  try {
    const rendered = renderNote(row.kind, noteFields(row), noteOptions(row), template);
    const r = syncNoteCards(ctx, row, rendered);
    ctx.db.prepare('UPDATE notes SET revision = revision + 1, updated_at = ? WHERE id = ?').run(nowIso(ctx), row.id);
    return r;
  } catch (e) {
    if (e instanceof NoteError) {
      // The note no longer produces any card (e.g. every front became empty): retire them all.
      const r = syncNoteCards(ctx, row, []);
      return { ...r, error: e.message };
    }
    throw e;
  }
}

export function duplicateNote(ctx: Ctx, id: string): Note {
  const row = getNoteRow(ctx, id);
  if (row.deleted_at) throw notFound('Note');
  return createNote(ctx, {
    sectionId: row.section_id,
    kind: row.kind,
    templateId: row.template_id,
    fields: noteFields(row),
    options: noteOptions(row),
    tags: noteTags(ctx, id),
  }).note;
}

/** Bump the edit revision of the notes owning these cards (card-level changes conflict with open editors too). */
export function touchNotesOfCards(ctx: Ctx, cardIds: string[]) {
  const ts = nowIso(ctx);
  const stmt = ctx.db.prepare('UPDATE notes SET revision = revision + 1, updated_at = ? WHERE id = (SELECT note_id FROM cards WHERE id = ?)');
  const done = new Set<string>();
  for (const cid of cardIds) {
    const nid = (ctx.db.prepare('SELECT note_id FROM cards WHERE id = ?').get(cid) as { note_id: string } | undefined)?.note_id;
    if (!nid || done.has(nid)) continue;
    done.add(nid);
    stmt.run(ts, cid);
  }
}

/** Distinct note ids for a list of card ids, in first-seen order. */
export function notesOfCards(ctx: Ctx, cardIds: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stmt = ctx.db.prepare('SELECT note_id FROM cards WHERE id = ?');
  for (const cid of cardIds) {
    const nid = (stmt.get(cid) as { note_id: string } | undefined)?.note_id;
    if (nid && !seen.has(nid)) {
      seen.add(nid);
      out.push(nid);
    }
  }
  return out;
}

/** Move whole notes (all their cards) to the end of another section. */
export function moveNotes(ctx: Ctx, noteIds: string[], sectionId: string) {
  assertSectionWritable(ctx, sectionId);
  let pos = nextNotePosition(ctx, sectionId);
  const ts = nowIso(ctx);
  for (const nid of noteIds) {
    ctx.db.prepare('UPDATE notes SET section_id = ?, position = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(sectionId, pos, ts, nid);
    ctx.db.prepare('UPDATE cards SET section_id = ?, position = ?, revision = revision + 1, updated_at = ? WHERE note_id = ?').run(sectionId, pos, ts, nid);
    pos++;
  }
}

/** Set note positions in a section; cards follow their note. */
export function reorderNotes(ctx: Ctx, sectionId: string, orderedNoteIds: string[]) {
  const siblings = ctx.db
    .prepare('SELECT id FROM notes WHERE section_id = ? ORDER BY position, created_at, id')
    .all(sectionId) as { id: string }[];
  const siblingIds = new Set(siblings.map((n) => n.id));
  for (const nid of orderedNoteIds) if (!siblingIds.has(nid)) throw badRequest('All reordered cards must belong to the same section');
  const listed = new Set(orderedNoteIds);
  const finalOrder = [...orderedNoteIds, ...siblings.map((n) => n.id).filter((nid) => !listed.has(nid))];
  const ts = nowIso(ctx);
  const n = ctx.db.prepare('UPDATE notes SET position = ?, updated_at = ? WHERE id = ?');
  const c = ctx.db.prepare('UPDATE cards SET position = ?, updated_at = ? WHERE note_id = ?');
  finalOrder.forEach((nid, position) => {
    n.run(position, ts, nid);
    c.run(position, ts, nid);
  });
}

/** Trash / restore / purge a note with all its cards. */
export function trashNote(ctx: Ctx, noteId: string) {
  const ts = nowIso(ctx);
  ctx.db.prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(ts, ts, noteId);
  ctx.db.prepare('UPDATE cards SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND retired_at IS NULL').run(ts, ts, noteId);
}

export function restoreNote(ctx: Ctx, noteId: string): boolean {
  const ts = nowIso(ctx);
  const r = ctx.db.prepare('UPDATE notes SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL').run(ts, noteId);
  if (r.changes === 0) return false;
  ctx.db.prepare('UPDATE cards SET deleted_at = NULL, updated_at = ? WHERE note_id = ? AND retired_at IS NULL').run(ts, noteId);
  return true;
}

export function noteDisplayTitle(ctx: Ctx, row: NoteRow): string {
  const template = row.kind === 'template' && row.template_id ? safeTemplate(ctx, row.template_id) : null;
  return noteTitle(row.kind, noteFields(row), template).slice(0, 160);
}

function safeTemplate(ctx: Ctx, id: string): NoteTemplateDef | null {
  try {
    return getTemplateDef(ctx, id);
  } catch (e) {
    if (e instanceof AppError) return null;
    throw e;
  }
}
