import { z } from 'zod';
import type { Card, CardFilter, CardListResponse } from '../../shared/types.ts';
import { nowIso, type Ctx } from '../context.ts';
import { badRequest, conflict, newId, notFound, placeholders } from '../lib/util.ts';
import { parse, zId } from '../lib/validate.ts';
import { getRow, impactOf, itemState, moveToTrash, removeOrphanTags } from './hierarchy.ts';
import { CARD_SELECT, toCard, type CardListRow, type CardRow } from './mappers.ts';
import { today } from './time.ts';

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

const cardCreate = z.object({
  sectionId: zId,
  front: zSide('Front'),
  back: zSide('Back'),
  explanation: z.string().max(MAX_SIDE).optional(),
  hint: z.string().max(10_000).optional(),
  source: z.string().max(500).optional(),
  tags: z.array(zTag).max(50).optional(),
  bookmarked: z.boolean().optional(),
});

const cardUpdate = cardCreate.partial().extend({
  revision: z.number().int().positive().optional(),
  suspended: z.boolean().optional(),
});

export function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Map<string, string>();
  for (const t of tags) {
    const clean = t.trim().replace(/\s+/g, ' ');
    if (clean && !seen.has(clean.toLowerCase())) seen.set(clean.toLowerCase(), clean);
  }
  return [...seen.values()];
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

function assertSectionWritable(ctx: Ctx, sectionId: string) {
  getRow(ctx, 'section', sectionId);
  if (itemState(ctx, 'section', sectionId).inTrash) throw badRequest('That section is in the trash');
}

export function getCard(ctx: Ctx, id: string): Card {
  const row = ctx.db
    .prepare(`SELECT ${CARD_SELECT} FROM card_ctx c LEFT JOIN card_schedules cs ON cs.card_id = c.id WHERE c.id = ?`)
    .get(id) as CardListRow | undefined;
  if (!row || row.deleted_at) throw notFound('Card');
  return toCard(row, today(ctx));
}

function nextCardPosition(ctx: Ctx, sectionId: string): number {
  const r = ctx.db.prepare('SELECT MAX(position) AS m FROM cards WHERE section_id = ?').get(sectionId) as { m: number | null };
  return (r.m ?? -1) + 1;
}

export function createCard(ctx: Ctx, input: unknown, opts: { isDemo?: boolean } = {}): Card {
  const data = parse(cardCreate, input);
  assertSectionWritable(ctx, data.sectionId);
  const id = newId(ctx.now().getTime());
  const ts = nowIso(ctx);
  ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `INSERT INTO cards (id, section_id, front, back, explanation, hint, source, bookmarked, position, is_demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.sectionId,
        data.front,
        data.back,
        data.explanation ?? '',
        data.hint ?? '',
        data.source?.trim() ?? '',
        data.bookmarked ? 1 : 0,
        nextCardPosition(ctx, data.sectionId),
        opts.isDemo ? 1 : 0,
        ts,
        ts,
      );
    setCardTags(ctx, id, data.tags ?? []);
  })();
  return getCard(ctx, id);
}

export function updateCard(ctx: Ctx, id: string, input: unknown): Card {
  const data = parse(cardUpdate, input);
  const existing = ctx.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
  if (!existing || existing.deleted_at) throw notFound('Card');
  if (itemState(ctx, 'section', existing.section_id).inTrash) {
    throw badRequest('This card’s section is in the trash. Restore it before editing the card.');
  }
  if (data.revision !== undefined && data.revision !== existing.revision) {
    throw conflict('revision_conflict', 'This card was changed elsewhere since you opened it.', {
      current: getCard(ctx, id),
    });
  }
  if (data.sectionId && data.sectionId !== existing.section_id) assertSectionWritable(ctx, data.sectionId);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (data.front !== undefined) set('front', data.front);
  if (data.back !== undefined) set('back', data.back);
  if (data.explanation !== undefined) set('explanation', data.explanation);
  if (data.hint !== undefined) set('hint', data.hint);
  if (data.source !== undefined) set('source', data.source.trim());
  if (data.bookmarked !== undefined) set('bookmarked', data.bookmarked ? 1 : 0);
  if (data.suspended !== undefined) set('suspended_at', data.suspended ? (existing.suspended_at ?? nowIso(ctx)) : null);
  if (data.sectionId && data.sectionId !== existing.section_id) {
    set('section_id', data.sectionId);
    set('position', nextCardPosition(ctx, data.sectionId));
  }
  ctx.db.transaction(() => {
    if (sets.length > 0 || data.tags) {
      set('revision', existing.revision + 1);
      set('updated_at', nowIso(ctx));
      ctx.db.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    }
    if (data.tags) {
      setCardTags(ctx, id, data.tags);
      removeOrphanTags(ctx);
    }
  })();
  return getCard(ctx, id);
}

export function duplicateCard(ctx: Ctx, id: string): Card {
  const src = getCard(ctx, id);
  return createCard(ctx, {
    sectionId: src.sectionId,
    front: src.front,
    back: src.back,
    explanation: src.explanation,
    hint: src.hint,
    source: src.source,
    tags: src.tags,
  });
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
        : '(SELECT position FROM courses WHERE id = course_id), (SELECT position FROM sections WHERE id = section_id), position, created_at, id';
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

export function bulkCards(ctx: Ctx, input: unknown): { affected: number } {
  const data = parse(bulkSchema, input);
  const ids = [...new Set(data.ids)];
  const existing = ctx.db
    .prepare(`SELECT id FROM cards WHERE deleted_at IS NULL AND id IN (${placeholders(ids.length)})`)
    .all(...ids) as { id: string }[];
  if (existing.length !== ids.length) throw badRequest('Some selected cards no longer exist');
  const ts = nowIso(ctx);
  const db = ctx.db;
  const run = db.transaction(() => {
    switch (data.action) {
      case 'move': {
        if (!data.sectionId) throw badRequest('Choose a destination section');
        assertSectionWritable(ctx, data.sectionId);
        let pos = nextCardPosition(ctx, data.sectionId);
        const stmt = db.prepare('UPDATE cards SET section_id = ?, position = ?, revision = revision + 1, updated_at = ? WHERE id = ?');
        for (const id of ids) stmt.run(data.sectionId, pos++, ts, id);
        break;
      }
      case 'addTags':
      case 'removeTags': {
        const tags = normalizeTags(data.tags);
        if (tags.length === 0) throw badRequest('Enter at least one tag');
        for (const id of ids) {
          const current = (
            db.prepare('SELECT t.name FROM card_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.card_id = ?').all(id) as { name: string }[]
          ).map((r) => r.name);
          const lower = new Set(tags.map((t) => t.toLowerCase()));
          const next =
            data.action === 'addTags' ? [...current, ...tags] : current.filter((t) => !lower.has(t.toLowerCase()));
          setCardTags(ctx, id, next);
          db.prepare('UPDATE cards SET revision = revision + 1, updated_at = ? WHERE id = ?').run(ts, id);
        }
        removeOrphanTags(ctx);
        break;
      }
      // Every change bumps the revision so an editor opened earlier gets a conflict instead of overwriting it.
      case 'suspend':
        db.prepare(`UPDATE cards SET suspended_at = COALESCE(suspended_at, ?), revision = revision + 1, updated_at = ? WHERE id IN (${placeholders(ids.length)})`).run(ts, ts, ...ids);
        break;
      case 'unsuspend':
        db.prepare(`UPDATE cards SET suspended_at = NULL, revision = revision + 1, updated_at = ? WHERE id IN (${placeholders(ids.length)})`).run(ts, ...ids);
        break;
      case 'bookmark':
      case 'unbookmark':
        db.prepare(`UPDATE cards SET bookmarked = ?, revision = revision + 1, updated_at = ? WHERE id IN (${placeholders(ids.length)})`).run(data.action === 'bookmark' ? 1 : 0, ts, ...ids);
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
  });
  run();
  return { affected: ids.length };
}
