import { z } from 'zod';
import type { Card, CardFilter, CardListResponse, Note } from '../../shared/types.ts';
import { nowIso, type Ctx } from '../context.ts';
import { badRequest, conflict, notFound, placeholders } from '../lib/util.ts';
import { parse, zId } from '../lib/validate.ts';
import { getRow, impactOf, itemState, moveToTrash, removeOrphanTags } from './hierarchy.ts';
import { CARD_SELECT, toCard, type CardListRow, type CardRow } from './mappers.ts';
import { captureCardAction, recordCardAction, undoCardAction } from './card-actions.ts';
import {
  createNote,
  duplicateNote,
  getNote,
  getNoteRow,
  moveNotes,
  normalizeTags,
  noteIdOfCard,
  noteOptions,
  notesOfCards,
  primaryCardId,
  reorderNotes,
  setCardTags,
  touchNotesOfCards,
  updateNote,
} from './notes.ts';
import { today } from './time.ts';

export { undoCardAction };

const MAX_SIDE = 200_000;

const zTag = z
  .string()
  .trim()
  .min(1)
  .max(60, 'Tags must be at most 60 characters')
  .refine((t) => !/[,\u001f]/.test(t), 'Tags cannot contain commas');

const zSide = (label: string) =>
  z
    .string()
    .max(MAX_SIDE, `${label} is too long`)
    .refine((v) => v.trim().length > 0, `${label} is required`);

/** The original card API: a basic note with one card. */
const cardCreate = z.object({
  sectionId: zId,
  front: zSide('Front'),
  back: zSide('Back'),
  explanation: z.string().max(MAX_SIDE).optional(),
  hint: z.string().max(10_000).optional(),
  source: z.string().max(500).optional(),
  tags: z.array(zTag).max(50).optional(),
  bookmarked: z.boolean().optional(),
  reverse: z.boolean().optional(),
});

const cardUpdate = cardCreate.partial().extend({
  revision: z.number().int().positive().optional(),
  suspended: z.boolean().optional(),
});

export { normalizeTags, setCardTags };

export function getCard(ctx: Ctx, id: string): Card {
  const row = ctx.db
    .prepare(`SELECT ${CARD_SELECT} FROM card_ctx c LEFT JOIN card_schedules cs ON cs.card_id = c.id WHERE c.id = ?`)
    .get(id) as CardListRow | undefined;
  if (!row || row.deleted_at) throw notFound('Card');
  return toCard(row, today(ctx));
}

/** A card with the note it belongs to (what the editor opens). */
export function getCardWithNote(ctx: Ctx, id: string): { card: Card; note: Note } {
  const card = getCard(ctx, id);
  return { card, note: getNote(ctx, card.noteId) };
}

export function createCard(ctx: Ctx, input: unknown, opts: { isDemo?: boolean } = {}): Card {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (raw.kind !== undefined || raw.fields !== undefined) {
    const { note } = createNote(ctx, input, opts);
    return getCard(ctx, primaryCardId(ctx, note.id));
  }
  const data = parse(cardCreate, input);
  const { note } = createNote(
    ctx,
    {
      sectionId: data.sectionId,
      kind: 'basic',
      fields: { front: data.front, back: data.back, explanation: data.explanation ?? '', hint: data.hint ?? '', source: data.source ?? '' },
      options: { reverse: data.reverse ?? false },
      tags: data.tags ?? [],
      bookmarked: data.bookmarked ?? false,
    },
    opts,
  );
  return getCard(ctx, primaryCardId(ctx, note.id));
}

/**
 * Update a card through the original API. Content fields edit the card's (basic) note;
 * `suspended` and `bookmarked` apply to this card only.
 */
export function updateCard(ctx: Ctx, id: string, input: unknown): Card {
  const data = parse(cardUpdate, input);
  const existing = ctx.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
  if (!existing || existing.deleted_at) throw notFound('Card');
  const note = getNoteRow(ctx, existing.note_id);
  if (itemState(ctx, 'section', existing.section_id).inTrash) {
    throw badRequest('This card’s section is in the trash. Restore it before editing the card.');
  }
  if (data.revision !== undefined && data.revision !== note.revision) {
    throw conflict('revision_conflict', 'This card was changed elsewhere since you opened it.', { current: getCard(ctx, id) });
  }
  const contentKeys = ['front', 'back', 'explanation', 'hint', 'source'] as const;
  const touchesContent = contentKeys.some((k) => data[k] !== undefined) || data.reverse !== undefined;
  if (touchesContent && note.kind !== 'basic') {
    throw badRequest('This card is generated from a note with several cards. Open it in the editor to change its content.');
  }
  ctx.db.transaction(() => {
    if (touchesContent || data.tags || (data.sectionId && data.sectionId !== note.section_id)) {
      const fields: Record<string, string> = {};
      for (const k of contentKeys) if (data[k] !== undefined) fields[k] = data[k]!;
      updateNote(
        ctx,
        note.id,
        {
          ...(touchesContent ? { fields } : {}),
          ...(data.reverse !== undefined ? { options: { ...noteOptions(note), reverse: data.reverse } } : {}),
          ...(data.tags ? { tags: data.tags } : {}),
          ...(data.sectionId ? { sectionId: data.sectionId } : {}),
        },
        { skipRevisionCheck: true },
      );
    }
    const ts = nowIso(ctx);
    if (data.suspended !== undefined) {
      ctx.db.prepare('UPDATE cards SET suspended_at = ?, updated_at = ? WHERE id = ?').run(data.suspended ? (existing.suspended_at ?? ts) : null, ts, id);
    }
    if (data.bookmarked !== undefined) ctx.db.prepare('UPDATE cards SET bookmarked = ?, updated_at = ? WHERE id = ?').run(data.bookmarked ? 1 : 0, ts, id);
    if ((data.suspended !== undefined || data.bookmarked !== undefined) && !touchesContent && !data.tags && !data.sectionId) touchNotesOfCards(ctx, [id]);
  })();
  return getCard(ctx, id);
}

export function duplicateCard(ctx: Ctx, id: string): Card {
  const note = duplicateNote(ctx, noteIdOfCard(ctx, id));
  return getCard(ctx, primaryCardId(ctx, note.id));
}

/** Reorder cards in a section. Cards of the same note always move together. */
export function reorderCards(ctx: Ctx, input: unknown) {
  const data = parse(z.object({ sectionId: zId, ids: z.array(zId).min(1).max(5000) }), input);
  if (new Set(data.ids).size !== data.ids.length) throw badRequest('Each card may appear only once in the order');
  getRow(ctx, 'section', data.sectionId);
  if (itemState(ctx, 'section', data.sectionId).inTrash) throw badRequest('That section is in the trash');
  const inSection = ctx.db.prepare('SELECT section_id FROM cards WHERE id = ?');
  for (const id of data.ids) {
    const r = inSection.get(id) as { section_id: string } | undefined;
    if (!r || r.section_id !== data.sectionId) throw badRequest('All reordered cards must belong to the same section');
  }
  const orderedNoteIds = notesOfCards(ctx, data.ids);
  const allNoteIds = (
    ctx.db
      .prepare('SELECT id FROM notes WHERE section_id = ? AND deleted_at IS NULL ORDER BY position, created_at, id')
      .all(data.sectionId) as { id: string }[]
  ).map((note) => note.id);
  let undoId = '';
  ctx.db.transaction(() => {
    const pending = captureCardAction(ctx, 'reorder', {
      noteIds: allNoteIds,
      sectionIds: [data.sectionId],
      affected: orderedNoteIds.length,
    });
    reorderNotes(ctx, data.sectionId, orderedNoteIds);
    undoId = recordCardAction(ctx, pending);
  })();
  return { ok: true, undoId };
}

export interface ListQuery {
  sectionId?: string;
  courseId?: string;
  semesterId?: string;
  programId?: string;
  q?: string;
  filter?: CardFilter;
  tag?: string;
  includeArchived?: boolean;
  sort?: 'position' | 'updated' | 'due';
  limit?: number;
  offset?: number;
}

/** Build an FTS5 query from free text: every token must match as a prefix. */
export function ftsQuery(q: string): string | null {
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/["*^():]/g, '').trim())
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function listCards(ctx: Ctx, query: ListQuery): CardListResponse {
  const where: string[] = ['c.in_trash = 0'];
  const params: unknown[] = [];
  const outer: string[] = [];
  const day = today(ctx);
  if (query.sectionId) {
    where.push('c.section_id = ?');
    params.push(query.sectionId);
  } else if (query.courseId) {
    where.push('c.course_id = ?');
    params.push(query.courseId);
  } else if (query.semesterId) {
    where.push('c.semester_id = ?');
    params.push(query.semesterId);
  } else if (query.programId) {
    where.push('c.program_id = ?');
    params.push(query.programId);
  }
  if (!query.includeArchived && !query.sectionId) where.push('c.in_archive = 0');
  switch (query.filter) {
    case 'new':
      where.push('c.suspended_at IS NULL AND cs.card_id IS NULL');
      break;
    case 'due':
      where.push('c.suspended_at IS NULL AND cs.due_date <= ?');
      params.push(day);
      break;
    case 'notDue':
      where.push('c.suspended_at IS NULL AND cs.due_date > ?');
      params.push(day);
      break;
    case 'bookmarked':
      where.push('c.bookmarked = 1');
      break;
    case 'suspended':
      where.push('c.suspended_at IS NOT NULL');
      break;
    case 'weak':
      outer.push('last_any_rating IN (1, 2)');
      break;
  }
  if (query.tag) {
    where.push('EXISTS (SELECT 1 FROM card_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.card_id = c.id AND t.name = ? COLLATE NOCASE)');
    params.push(query.tag);
  }
  const q = query.q?.trim();
  if (q) {
    const fts = ftsQuery(q);
    const like = `%${escapeLike(q)}%`;
    const parts = [
      `c.front LIKE ? ESCAPE '\\'`,
      `c.back LIKE ? ESCAPE '\\'`,
      `c.explanation LIKE ? ESCAPE '\\'`,
      `c.source LIKE ? ESCAPE '\\'`,
      `EXISTS (SELECT 1 FROM card_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.card_id = c.id AND t.name LIKE ? ESCAPE '\\')`,
    ];
    params.push(like, like, like, like, like);
    if (fts) {
      parts.push('c.id IN (SELECT cards.id FROM cards_fts JOIN cards ON cards.rowid = cards_fts.rowid WHERE cards_fts MATCH ?)');
      params.push(fts);
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  const order =
    query.sort === 'updated'
      ? 'updated_at DESC, id'
      : query.sort === 'due'
        ? 'CASE WHEN s_due_date IS NULL THEN 1 ELSE 0 END, s_due_date, id'
        : '(SELECT position FROM courses WHERE id = course_id), (SELECT position FROM sections WHERE id = section_id), position, variant_order, created_at, id';
  const inner = `SELECT ${CARD_SELECT} FROM card_ctx c LEFT JOIN card_schedules cs ON cs.card_id = c.id WHERE ${where.join(' AND ')}`;
  const outerWhere = outer.length ? `WHERE ${outer.join(' AND ')}` : '';
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM (${inner}) ${outerWhere}`).get(...params) as { n: number }).n;
  const limit = Math.min(Math.max(1, query.limit ?? 500), 2000);
  const offset = Math.max(0, query.offset ?? 0);
  const rows = ctx.db
    .prepare(`SELECT * FROM (${inner}) ${outerWhere} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as CardListRow[];
  return { cards: rows.map((r) => toCard(r, day)), total };
}

export function listTags(ctx: Ctx): { name: string; count: number }[] {
  return ctx.db
    .prepare(
      `SELECT t.name, COUNT(c.id) AS count FROM tags t
       JOIN card_tags ct ON ct.tag_id = t.id
       JOIN card_ctx c ON c.id = ct.card_id AND c.in_trash = 0
       GROUP BY t.id ORDER BY t.name COLLATE NOCASE`,
    )
    .all() as { name: string; count: number }[];
}

const bulkSchema = z.object({
  ids: z.array(zId).min(1).max(5000),
  action: z.enum(['move', 'addTags', 'removeTags', 'suspend', 'unsuspend', 'bookmark', 'unbookmark', 'delete']),
  sectionId: zId.optional(),
  tags: z.array(zTag).max(50).optional(),
});

export function bulkCards(ctx: Ctx, input: unknown): { affected: number; undoId?: string } {
  const data = parse(bulkSchema, input);
  const ids = [...new Set(data.ids)];
  const existing = ctx.db
    .prepare(`SELECT id FROM cards WHERE deleted_at IS NULL AND id IN (${placeholders(ids.length)})`)
    .all(...ids) as { id: string }[];
  if (existing.length !== ids.length) throw badRequest('Some selected cards no longer exist');
  const ts = nowIso(ctx);
  const db = ctx.db;
  let undoId: string | undefined;
  const run = db.transaction(() => {
    const noteIds = notesOfCards(ctx, ids);
    let pending: ReturnType<typeof captureCardAction> | undefined;
    if (data.action === 'move') {
      if (!data.sectionId) throw badRequest('Choose a destination section');
      const sourceSections = (
        db.prepare(`SELECT DISTINCT section_id FROM notes WHERE id IN (${placeholders(noteIds.length)})`).all(...noteIds) as { section_id: string }[]
      ).map((row) => row.section_id);
      pending = captureCardAction(ctx, 'move', {
        noteIds,
        sectionIds: [...sourceSections, data.sectionId],
        affected: ids.length,
      });
    } else if (data.action === 'addTags' || data.action === 'removeTags') {
      pending = captureCardAction(ctx, data.action, { noteIds, affected: ids.length });
    } else if (data.action === 'suspend' || data.action === 'unsuspend') {
      pending = captureCardAction(ctx, data.action, { noteIds, cardIds: ids, affected: ids.length });
    }
    switch (data.action) {
      case 'move': {
        // Cards of one note stay together, so moving a card moves its whole note.
        moveNotes(ctx, noteIds, data.sectionId!);
        break;
      }
      case 'addTags':
      case 'removeTags': {
        const tags = normalizeTags(data.tags);
        if (tags.length === 0) throw badRequest('Enter at least one tag');
        const lower = new Set(tags.map((t) => t.toLowerCase()));
        for (const noteId of notesOfCards(ctx, ids)) {
          const live = db.prepare('SELECT id FROM cards WHERE note_id = ? AND retired_at IS NULL').all(noteId) as { id: string }[];
          const current = (
            db.prepare('SELECT t.name FROM card_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.card_id = ?').all(live[0]?.id ?? '') as { name: string }[]
          ).map((r) => r.name);
          const next = data.action === 'addTags' ? [...current, ...tags] : current.filter((t) => !lower.has(t.toLowerCase()));
          for (const c of live) setCardTags(ctx, c.id, next);
          db.prepare('UPDATE notes SET revision = revision + 1, updated_at = ? WHERE id = ?').run(ts, noteId);
          db.prepare('UPDATE cards SET revision = revision + 1, updated_at = ? WHERE note_id = ? AND retired_at IS NULL').run(ts, noteId);
        }
        removeOrphanTags(ctx);
        break;
      }
      // Card-level changes bump the note's revision so an editor opened earlier gets a conflict instead of overwriting it.
      case 'suspend':
        db.prepare(`UPDATE cards SET suspended_at = COALESCE(suspended_at, ?), revision = revision + 1, updated_at = ? WHERE id IN (${placeholders(ids.length)})`).run(ts, ts, ...ids);
        touchNotesOfCards(ctx, ids);
        break;
      case 'unsuspend':
        db.prepare(`UPDATE cards SET suspended_at = NULL, revision = revision + 1, updated_at = ? WHERE id IN (${placeholders(ids.length)})`).run(ts, ...ids);
        touchNotesOfCards(ctx, ids);
        break;
      case 'bookmark':
      case 'unbookmark':
        db.prepare(`UPDATE cards SET bookmarked = ?, revision = revision + 1, updated_at = ? WHERE id IN (${placeholders(ids.length)})`).run(data.action === 'bookmark' ? 1 : 0, ts, ...ids);
        touchNotesOfCards(ctx, ids);
        break;
      case 'delete':
        for (const id of ids) {
          if (impactOf(ctx, 'card', id).openSessionCards > 0) {
            throw conflict('in_open_session', 'Some selected cards belong to the open study session. Finish or end it first.');
          }
        }
        for (const id of ids) moveToTrash(ctx, 'card', id);
        break;
    }
    if (pending) undoId = recordCardAction(ctx, pending);
  });
  run();
  return { affected: ids.length, ...(undoId ? { undoId } : {}) };
}
