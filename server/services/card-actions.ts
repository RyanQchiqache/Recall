import type { Ctx } from '../context.ts';
import { nowIso } from '../context.ts';
import { conflict, newId, notFound, parseJson, placeholders } from '../lib/util.ts';
import { parse, zId } from '../lib/validate.ts';
import { removeOrphanTags } from './hierarchy.ts';
import { setCardTags, touchNotesOfCards } from './notes.ts';

export type UndoableCardAction = 'move' | 'addTags' | 'removeTags' | 'suspend' | 'unsuspend' | 'reorder';

interface NoteBefore {
  id: string;
  sectionId: string;
  position: number;
  revision: number;
  tags: string[];
}

interface CardBefore {
  id: string;
  noteId: string;
  revision: number;
  suspendedAt: string | null;
}

interface PendingAction {
  action: UndoableCardAction;
  affected: number;
  notes: NoteBefore[];
  cards: CardBefore[];
  sectionOrdersBefore: Record<string, string[]>;
}

interface StoredNote extends NoteBefore {
  expectedRevision: number;
}

interface StoredCard extends CardBefore {
  expectedRevision: number;
}

interface StoredAction extends Omit<PendingAction, 'notes' | 'cards'> {
  notes: StoredNote[];
  cards: StoredCard[];
  sectionOrdersAfter: Record<string, string[]>;
}

function sectionOrder(ctx: Ctx, sectionId: string): string[] {
  return (
    ctx.db
      .prepare('SELECT id FROM notes WHERE section_id = ? AND deleted_at IS NULL ORDER BY position, created_at, id')
      .all(sectionId) as { id: string }[]
  ).map((row) => row.id);
}

function sectionOrders(ctx: Ctx, sectionIds: string[]): Record<string, string[]> {
  return Object.fromEntries([...new Set(sectionIds)].map((sectionId) => [sectionId, sectionOrder(ctx, sectionId)]));
}

function tagsForNote(ctx: Ctx, noteId: string): string[] {
  return (
    ctx.db
      .prepare(
        `SELECT DISTINCT t.name
         FROM cards c JOIN card_tags ct ON ct.card_id = c.id JOIN tags t ON t.id = ct.tag_id
         WHERE c.note_id = ? AND c.retired_at IS NULL
         ORDER BY t.name COLLATE NOCASE`,
      )
      .all(noteId) as { name: string }[]
  ).map((row) => row.name);
}

export function captureCardAction(
  ctx: Ctx,
  action: UndoableCardAction,
  opts: { noteIds: string[]; cardIds?: string[]; sectionIds?: string[]; affected: number },
): PendingAction {
  const noteIds = [...new Set(opts.noteIds)];
  const cardIds = [...new Set(opts.cardIds ?? [])];
  const notes = noteIds.length
    ? (ctx.db
        .prepare(`SELECT id, section_id, position, revision FROM notes WHERE deleted_at IS NULL AND id IN (${placeholders(noteIds.length)})`)
        .all(...noteIds) as { id: string; section_id: string; position: number; revision: number }[])
    : [];
  const cards = cardIds.length
    ? (ctx.db
        .prepare(
          `SELECT id, note_id, revision, suspended_at FROM cards
           WHERE deleted_at IS NULL AND retired_at IS NULL AND id IN (${placeholders(cardIds.length)})`,
        )
        .all(...cardIds) as { id: string; note_id: string; revision: number; suspended_at: string | null }[])
    : [];
  if (notes.length !== noteIds.length || cards.length !== cardIds.length) {
    throw conflict('card_action_conflict', 'Some selected cards changed before the action could be recorded.');
  }
  const byNote = new Map(notes.map((note) => [note.id, note]));
  const byCard = new Map(cards.map((card) => [card.id, card]));
  return {
    action,
    affected: opts.affected,
    notes: noteIds.map((id) => {
      const note = byNote.get(id)!;
      return { id, sectionId: note.section_id, position: note.position, revision: note.revision, tags: tagsForNote(ctx, id) };
    }),
    cards: cardIds.map((id) => {
      const card = byCard.get(id)!;
      return { id, noteId: card.note_id, revision: card.revision, suspendedAt: card.suspended_at };
    }),
    sectionOrdersBefore: sectionOrders(ctx, opts.sectionIds ?? []),
  };
}

export function recordCardAction(ctx: Ctx, pending: PendingAction): string {
  const noteRevisions = new Map(
    pending.notes.map((note) => [
      note.id,
      (ctx.db.prepare('SELECT revision FROM notes WHERE id = ? AND deleted_at IS NULL').get(note.id) as { revision: number } | undefined)?.revision,
    ]),
  );
  const cardRevisions = new Map(
    pending.cards.map((card) => [
      card.id,
      (ctx.db.prepare('SELECT revision FROM cards WHERE id = ? AND deleted_at IS NULL AND retired_at IS NULL').get(card.id) as { revision: number } | undefined)?.revision,
    ]),
  );
  if ([...noteRevisions.values(), ...cardRevisions.values()].some((revision) => revision === undefined)) {
    throw conflict('card_action_conflict', 'Some selected cards changed before the action could be recorded.');
  }
  const payload: StoredAction = {
    ...pending,
    notes: pending.notes.map((note) => ({ ...note, expectedRevision: noteRevisions.get(note.id)! })),
    cards: pending.cards.map((card) => ({ ...card, expectedRevision: cardRevisions.get(card.id)! })),
    sectionOrdersAfter: sectionOrders(ctx, Object.keys(pending.sectionOrdersBefore)),
  };
  const id = newId(ctx.now().getTime());
  ctx.db
    .prepare('INSERT INTO card_action_undos (id, action, payload_json, created_at) VALUES (?, ?, ?, ?)')
    .run(id, pending.action, JSON.stringify(payload), nowIso(ctx));
  return id;
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function failConflict(): never {
  throw conflict(
    'card_action_conflict',
    'These cards changed after that action, so Recall left the newer changes in place.',
  );
}

export function undoCardAction(ctx: Ctx, inputId: string): { affected: number } {
  const id = parse(zId, inputId);
  let affected = 0;
  ctx.db.transaction(() => {
    const row = ctx.db.prepare('SELECT payload_json, undone_at FROM card_action_undos WHERE id = ?').get(id) as
      | { payload_json: string; undone_at: string | null }
      | undefined;
    if (!row) throw notFound('Undo action');
    if (row.undone_at) throw conflict('card_action_already_undone', 'That action has already been undone.');
    const payload = parseJson<StoredAction | null>(row.payload_json, null);
    if (!payload) failConflict();

    for (const note of payload.notes) {
      const current = ctx.db.prepare('SELECT revision, deleted_at FROM notes WHERE id = ?').get(note.id) as
        | { revision: number; deleted_at: string | null }
        | undefined;
      if (!current || current.deleted_at || current.revision !== note.expectedRevision) failConflict();
    }
    for (const card of payload.cards) {
      const current = ctx.db.prepare('SELECT revision, deleted_at, retired_at FROM cards WHERE id = ?').get(card.id) as
        | { revision: number; deleted_at: string | null; retired_at: string | null }
        | undefined;
      if (!current || current.deleted_at || current.retired_at || current.revision !== card.expectedRevision) failConflict();
    }
    for (const [sectionId, expected] of Object.entries(payload.sectionOrdersAfter)) {
      if (!sameOrder(sectionOrder(ctx, sectionId), expected)) failConflict();
    }

    const ts = nowIso(ctx);
    if (payload.action === 'move' || payload.action === 'reorder') {
      const current = new Map(
        (ctx.db.prepare('SELECT id, section_id, position FROM notes').all() as { id: string; section_id: string; position: number }[]).map((note) => [note.id, note]),
      );
      for (const [sectionId, noteIds] of Object.entries(payload.sectionOrdersBefore)) {
        noteIds.forEach((noteId, position) => {
          const note = current.get(noteId);
          if (!note) failConflict();
          if (note.section_id === sectionId && note.position === position) return;
          ctx.db
            .prepare('UPDATE notes SET section_id = ?, position = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
            .run(sectionId, position, ts, noteId);
          ctx.db
            .prepare('UPDATE cards SET section_id = ?, position = ?, revision = revision + 1, updated_at = ? WHERE note_id = ?')
            .run(sectionId, position, ts, noteId);
        });
      }
    } else if (payload.action === 'addTags' || payload.action === 'removeTags') {
      for (const note of payload.notes) {
        const cards = ctx.db
          .prepare('SELECT id FROM cards WHERE note_id = ? AND retired_at IS NULL AND deleted_at IS NULL')
          .all(note.id) as { id: string }[];
        for (const card of cards) setCardTags(ctx, card.id, note.tags);
        ctx.db.prepare('UPDATE cards SET revision = revision + 1, updated_at = ? WHERE note_id = ? AND retired_at IS NULL').run(ts, note.id);
        ctx.db.prepare('UPDATE notes SET revision = revision + 1, updated_at = ? WHERE id = ?').run(ts, note.id);
      }
      removeOrphanTags(ctx);
    } else {
      for (const card of payload.cards) {
        ctx.db
          .prepare('UPDATE cards SET suspended_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
          .run(card.suspendedAt, ts, card.id);
      }
      touchNotesOfCards(ctx, payload.cards.map((card) => card.id));
    }

    const marked = ctx.db.prepare('UPDATE card_action_undos SET undone_at = ? WHERE id = ? AND undone_at IS NULL').run(ts, id);
    if (marked.changes !== 1) throw conflict('card_action_already_undone', 'That action has already been undone.');
    affected = payload.affected;
  })();
  return { affected };
}
