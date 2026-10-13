import { z } from 'zod';
import { createQueue, progressOf, rate as queueRate, relax as queueRelax, selectNext, clampMaxAttempts, type QueueEntry, type QueueState } from '../../shared/queue.ts';
import { seededShuffle } from '../../shared/random.ts';
import { isRating, isWeakRating, type Rating, type StudyMode } from '../../shared/ratings.ts';
import { getScheduler, normalizeSchedulerSettings, type ScheduleState, type SchedulerSettings } from '../../shared/scheduler.ts';
import { MAX_SESSION_SIZE } from '../../shared/settings.ts';
import type {
  CardSnapshot,
  ScopeSummaryItem,
  SessionFilters,
  SessionOrdering,
  SessionPreview,
  SessionRequest,
  SessionResults,
  SessionScope,
  SessionState,
  SessionStatus,
  SessionSummary,
} from '../../shared/types.ts';
import { nowIso, type Ctx } from '../context.ts';
import { AppError, badRequest, conflict, newId, notFound, parseJson, placeholders } from '../lib/util.ts';
import { parse, zId } from '../lib/validate.ts';
import type { ScheduleRow } from './mappers.ts';
import { getSettings } from './settings.ts';
import { today } from './time.ts';

/** Gaps longer than this between interactions are not counted as active study time. */
export const IDLE_CAP_MS = 10 * 60 * 1000;

// ---------- Request validation ----------

const scopeSchema = z.object({
  sectionIds: z.array(zId).max(2000).optional(),
  courseIds: z.array(zId).max(500).optional(),
  semesterId: zId.nullable().optional(),
  cardIds: z.array(zId).max(MAX_SESSION_SIZE).optional(),
});

const filtersSchema = z.object({
  includeNew: z.boolean().default(true),
  tags: z.array(z.string().max(60)).max(50).default([]),
  bookmarkedOnly: z.boolean().default(false),
  status: z.enum(['any', 'new', 'due', 'notDue', 'weak', 'reviewed']).default('any'),
  weakBasis: z.enum(['all', 'scheduled']).default('all'),
});

const requestSchema = z.object({
  mode: z.enum(['scheduled', 'practice', 'test']),
  scope: scopeSchema,
  filters: filtersSchema.default({ includeNew: true, tags: [], bookmarkedOnly: false, status: 'any', weakBasis: 'all' }),
  ordering: z.enum(['default', 'random', 'weakest']).default('default'),
  size: z.number().int().min(1, 'Choose at least one card').max(MAX_SESSION_SIZE),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  seed: z.number().int().min(0).max(0xffffffff).optional(),
  title: z.string().max(200).optional(),
  acceptSmaller: z.boolean().optional(),
});

// ---------- Candidate selection ----------

interface Candidate {
  id: string;
  section_id: string;
  course_id: string;
  created_at: string;
  position: number;
  suspended_at: string | null;
  bookmarked: number;
  due_date: string | null;
  course_pos: number;
  section_pos: number;
  last_any: number | null;
  last_scheduled: number | null;
  last_any_at: string | null;
  last_scheduled_at: string | null;
}

type Reason = 'due' | 'new' | 'notDue';

interface Selection {
  preview: SessionPreview;
  selected: { id: string; reason: Reason }[];
}

function hasScope(scope: SessionScope): boolean {
  return Boolean(
    scope.sectionIds?.length || scope.courseIds?.length || scope.semesterId || scope.cardIds?.length,
  );
}

function scopeItems(ctx: Ctx, scope: SessionScope): ScopeSummaryItem[] {
  const items: ScopeSummaryItem[] = [];
  const db = ctx.db;
  if (scope.semesterId) {
    const r = db.prepare('SELECT id, title FROM semesters WHERE id = ?').get(scope.semesterId) as ScopeSummaryItem | undefined;
    if (r) items.push({ ...r, level: 'semester' });
  }
  for (const id of scope.courseIds ?? []) {
    const r = db.prepare('SELECT id, title FROM courses WHERE id = ?').get(id) as ScopeSummaryItem | undefined;
    if (r) items.push({ ...r, level: 'course' });
  }
  for (const id of scope.sectionIds ?? []) {
    const r = db
      .prepare('SELECT s.id, s.title, c.title AS course_title FROM sections s JOIN courses c ON c.id = s.course_id WHERE s.id = ?')
      .get(id) as (ScopeSummaryItem & { course_title: string }) | undefined;
    if (r) items.push({ id: r.id, title: `${r.course_title} › ${r.title}`, level: 'section' });
  }
  return items;
}

function scopeLabel(scope: SessionScope, items: ScopeSummaryItem[]): string {
  if (scope.cardIds?.length) return `${scope.cardIds.length} selected card${scope.cardIds.length === 1 ? '' : 's'}`;
  if (items.length === 0) return 'Nothing selected';
  if (items.length === 1) {
    const it = items[0];
    return it.level === 'semester' ? `All courses in ${it.title}` : it.title;
  }
  const sections = items.filter((i) => i.level === 'section').length;
  const courses = items.filter((i) => i.level === 'course').length;
  const parts: string[] = [];
  if (items.some((i) => i.level === 'semester')) parts.push(`all of ${items.find((i) => i.level === 'semester')!.title}`);
  if (courses) parts.push(`${courses} course${courses === 1 ? '' : 's'}`);
  if (sections) parts.push(`${sections} section${sections === 1 ? '' : 's'}`);
  return parts.join(' + ');
}

function loadCandidates(ctx: Ctx, scope: SessionScope): Candidate[] {
  const ors: string[] = [];
  const params: unknown[] = [];
  if (scope.sectionIds?.length) {
    ors.push(`c.section_id IN (${placeholders(scope.sectionIds.length)})`);
    params.push(...scope.sectionIds);
  }
  if (scope.courseIds?.length) {
    ors.push(`c.course_id IN (${placeholders(scope.courseIds.length)})`);
    params.push(...scope.courseIds);
  }
  if (scope.semesterId) {
    ors.push('c.semester_id = ?');
    params.push(scope.semesterId);
  }
  if (scope.cardIds?.length) {
    ors.push(`c.id IN (${placeholders(scope.cardIds.length)})`);
    params.push(...scope.cardIds);
  }
  if (ors.length === 0) return [];
  const lastRating = (modeFilter: string, col: string) =>
    `(SELECT re.${col} FROM review_events re WHERE re.card_id = c.id AND re.undone_at IS NULL ${modeFilter}
      ORDER BY re.rated_at DESC, re.attempt_index DESC LIMIT 1)`;
  return ctx.db
    .prepare(
      `SELECT c.id, c.section_id, c.course_id, c.created_at, c.position, c.suspended_at, c.bookmarked,
         cs.due_date,
         (SELECT position FROM courses WHERE id = c.course_id) AS course_pos,
         (SELECT position FROM sections WHERE id = c.section_id) AS section_pos,
         ${lastRating('', 'rating')} AS last_any,
         ${lastRating("AND re.mode = 'scheduled'", 'rating')} AS last_scheduled,
         ${lastRating('', 'rated_at')} AS last_any_at,
         ${lastRating("AND re.mode = 'scheduled'", 'rated_at')} AS last_scheduled_at
       FROM card_ctx c LEFT JOIN card_schedules cs ON cs.card_id = c.id
       WHERE c.in_trash = 0 AND c.in_archive = 0 AND (${ors.join(' OR ')})`,
    )
    .all(...params) as Candidate[];
}

function cardTagsMap(ctx: Ctx, ids: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = ctx.db
      .prepare(
        `SELECT ct.card_id, t.name FROM card_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.card_id IN (${placeholders(chunk.length)})`,
      )
      .all(...chunk) as { card_id: string; name: string }[];
    for (const r of rows) {
      const list = map.get(r.card_id) ?? [];
      list.push(r.name);
      map.set(r.card_id, list);
    }
  }
  return map;
}

const hierarchyOrder = (a: Candidate, b: Candidate) =>
  a.course_pos - b.course_pos ||
  a.section_pos - b.section_pos ||
  a.position - b.position ||
  a.created_at.localeCompare(b.created_at) ||
  a.id.localeCompare(b.id);

const dueOrder = (a: Candidate, b: Candidate) =>
  (a.due_date ?? '').localeCompare(b.due_date ?? '') || a.id.localeCompare(b.id);

function weaknessRank(c: Candidate, basis: 'all' | 'scheduled'): number {
  const r = basis === 'scheduled' ? c.last_scheduled : c.last_any;
  return r === null ? 4 : r - 1; // Bad 0, Good 1, Very good 2, Perfect 3, never reviewed 4
}

export function computeSelection(ctx: Ctx, req: SessionRequest, seed: number): Selection {
  const day = today(ctx);
  const items = scopeItems(ctx, req.scope);
  const label = req.scope.cardIds?.length ? scopeLabel(req.scope, items) : scopeLabel(req.scope, items);
  const all = hasScope(req.scope) ? loadCandidates(ctx, req.scope) : [];
  const tagFilter = req.filters.tags.map((t) => t.toLowerCase());
  const tagsMap = tagFilter.length ? cardTagsMap(ctx, all.map((c) => c.id)) : new Map<string, string[]>();
  const suspended = all.filter((c) => c.suspended_at !== null).length;
  const matching = all.filter((c) => {
    if (c.suspended_at !== null) return false;
    if (req.filters.bookmarkedOnly && c.bookmarked !== 1) return false;
    if (tagFilter.length) {
      const tags = (tagsMap.get(c.id) ?? []).map((t) => t.toLowerCase());
      if (!tags.some((t) => tagFilter.includes(t))) return false;
    }
    return true;
  });
  const isNew = (c: Candidate) => c.due_date === null;
  const isDue = (c: Candidate) => c.due_date !== null && c.due_date <= day;
  const weakOf = (c: Candidate) =>
    isWeakRating(((req.filters.weakBasis === 'scheduled' ? c.last_scheduled : c.last_any) ?? null) as Rating | null);
  const neverOf = (c: Candidate) => (req.filters.weakBasis === 'scheduled' ? c.last_scheduled : c.last_any) === null;
  const breakdown = {
    total: matching.length,
    due: matching.filter(isDue).length,
    new: matching.filter(isNew).length,
    notYetDue: matching.filter((c) => !isNew(c) && !isDue(c)).length,
    weak: matching.filter(weakOf).length,
    neverReviewed: matching.filter(neverOf).length,
    suspended,
  };

  let eligible: Candidate[];
  if (req.mode === 'scheduled') {
    eligible = matching.filter((c) => isDue(c) || (req.filters.includeNew && isNew(c)));
  } else {
    eligible = matching.filter((c) => {
      switch (req.filters.status) {
        case 'new':
          return isNew(c);
        case 'due':
          return isDue(c);
        case 'notDue':
          return !isNew(c) && !isDue(c);
        case 'weak':
          return weakOf(c);
        case 'reviewed':
          return !neverOf(c);
        default:
          return true;
      }
    });
  }

  // Order the full eligible pool, then take the first N (sampling without replacement).
  let ordered: Candidate[];
  const basis = req.filters.weakBasis;
  const byWeakness = (a: Candidate, b: Candidate) =>
    weaknessRank(a, basis) - weaknessRank(b, basis) ||
    ((basis === 'scheduled' ? a.last_scheduled_at : a.last_any_at) ?? '').localeCompare(
      (basis === 'scheduled' ? b.last_scheduled_at : b.last_any_at) ?? '',
    ) ||
    a.id.localeCompare(b.id);
  if (req.mode === 'scheduled') {
    const due = eligible.filter(isDue);
    const fresh = eligible.filter(isNew);
    if (req.ordering === 'random') {
      ordered = [...seededShuffle(due.sort(dueOrder), seed), ...seededShuffle(fresh.sort(hierarchyOrder), seed ^ 0x9e3779b9)];
    } else if (req.ordering === 'weakest') {
      ordered = [...due.sort(byWeakness), ...fresh.sort(hierarchyOrder)];
    } else {
      ordered = [...due.sort(dueOrder), ...fresh.sort(hierarchyOrder)];
    }
  } else if (req.ordering === 'random') {
    ordered = seededShuffle(eligible.sort(hierarchyOrder), seed);
  } else if (req.ordering === 'weakest') {
    ordered = eligible.sort(byWeakness);
  } else {
    ordered = eligible.sort(hierarchyOrder);
  }
  let chosen = ordered.slice(0, req.size);
  // For random ordering, present the chosen cards in a shuffled order too (stable for this seed).
  if (req.ordering === 'random' && req.mode === 'scheduled') chosen = seededShuffle(chosen, seed ^ 0x5bd1e995);
  const reason = (c: Candidate): Reason => (isNew(c) ? 'new' : isDue(c) ? 'due' : 'notDue');
  const selected = chosen.map((c) => ({ id: c.id, reason: reason(c) }));
  return {
    selected,
    preview: {
      scopeLabel: label,
      scopeItems: items,
      breakdown,
      available: eligible.length,
      requested: req.size,
      willSelect: selected.length,
      selection: {
        due: selected.filter((s) => s.reason === 'due').length,
        new: selected.filter((s) => s.reason === 'new').length,
        notYetDue: selected.filter((s) => s.reason === 'notDue').length,
      },
    },
  };
}

export function parseRequest(input: unknown): SessionRequest {
  const req = parse(requestSchema, input) as SessionRequest;
  if (req.mode === 'test') req.maxAttempts = 1;
  req.maxAttempts = clampMaxAttempts(req.maxAttempts);
  if (req.scope.cardIds?.length) req.scope.cardIds = [...new Set(req.scope.cardIds)];
  return req;
}

export function previewSession(ctx: Ctx, input: unknown): SessionPreview {
  const req = parseRequest(input);
  return computeSelection(ctx, req, req.seed ?? 1).preview;
}

// ---------- Session persistence ----------

interface SessionRow {
  id: string;
  mode: StudyMode;
  status: SessionStatus;
  is_open: number | null;
  title: string;
  scope_json: string;
  filters_json: string;
  ordering: SessionOrdering;
  seed: number;
  requested_size: number;
  settings_json: string;
  scheduler_version: string;
  max_attempts: number;
  attempt_counter: number;
  next_queue_order: number;
  current_card_id: string | null;
  revealed: number;
  hint_shown: number;
  typed_answer: string;
  relaxed: number;
  active_ms: number;
  active_ms_marked: number;
  last_activity_at: string | null;
  revision: number;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface SessionCardRow {
  session_id: string;
  card_id: string;
  initial_position: number;
  queue_order: number;
  eligible_after: number;
  attempts: number;
  status: 'pending' | 'completed' | 'unresolved';
  first_rating: number | null;
  final_rating: number | null;
  selection_reason: string;
  card_revision: number;
  snapshot_json: string;
  section_id: string;
  course_id: string;
}

interface SettingsSnapshot {
  scheduler: SchedulerSettings;
  schedulerVersion: string;
  timeZone: string;
  maxAttempts: number;
  scopeLabel: string;
}

/** The mutable session fields an undo must restore. */
interface SessionUndoFields {
  attempt_counter: number;
  next_queue_order: number;
  current_card_id: string | null;
  revealed: number;
  hint_shown: number;
  typed_answer: string;
  relaxed: number;
  status: SessionStatus;
  is_open: number | null;
  finished_at: string | null;
}

interface UndoPayload {
  session: SessionUndoFields;
  card: SessionCardRow;
}

function getSessionRow(ctx: Ctx, id: string): SessionRow {
  const row = ctx.db.prepare('SELECT * FROM study_sessions WHERE id = ?').get(id) as SessionRow | undefined;
  if (!row) throw notFound('Study session');
  return row;
}

function getSessionCards(ctx: Ctx, id: string): SessionCardRow[] {
  return ctx.db
    .prepare('SELECT * FROM session_cards WHERE session_id = ? ORDER BY initial_position')
    .all(id) as SessionCardRow[];
}

function toQueue(s: SessionRow, cards: SessionCardRow[]): QueueState {
  return {
    attemptCounter: s.attempt_counter,
    nextQueueOrder: s.next_queue_order,
    maxAttempts: s.max_attempts,
    relaxed: s.relaxed === 1,
    currentCardId: s.current_card_id,
    entries: cards.map(
      (c): QueueEntry => ({
        cardId: c.card_id,
        queueOrder: c.queue_order,
        eligibleAfter: c.eligible_after,
        attempts: c.attempts,
        status: c.status,
        firstRating: (c.first_rating ?? null) as Rating | null,
        finalRating: (c.final_rating ?? null) as Rating | null,
      }),
    ),
  };
}

function snapshotOf(row: SessionCardRow): CardSnapshot {
  return parseJson<CardSnapshot>(row.snapshot_json, {
    front: '',
    back: '',
    explanation: '',
    hint: '',
    source: '',
    tags: [],
    sectionTitle: '',
    courseTitle: '',
    courseColor: 'indigo',
  });
}

function summaryOf(s: SessionRow, cards: SessionCardRow[]): SessionSummary {
  const settings = parseJson<Partial<SettingsSnapshot>>(s.settings_json, {});
  return {
    id: s.id,
    mode: s.mode,
    status: s.status,
    title: s.title,
    scopeLabel: settings.scopeLabel ?? s.title,
    startedAt: s.started_at,
    updatedAt: s.updated_at,
    finishedAt: s.finished_at,
    activeMs: s.active_ms,
    progress: progressOf(toQueue(s, cards)),
  };
}

export function getOpenSession(ctx: Ctx): SessionSummary | null {
  const row = ctx.db.prepare('SELECT * FROM study_sessions WHERE is_open = 1').get() as SessionRow | undefined;
  return row ? summaryOf(row, getSessionCards(ctx, row.id)) : null;
}

export function listSessions(ctx: Ctx, limit = 20): SessionSummary[] {
  const rows = ctx.db
    .prepare('SELECT * FROM study_sessions ORDER BY started_at DESC LIMIT ?')
    .all(Math.min(200, Math.max(1, limit))) as SessionRow[];
  return rows.map((r) => summaryOf(r, getSessionCards(ctx, r.id)));
}

export function createSession(ctx: Ctx, input: unknown): SessionState {
  const req = parseRequest(input);
  if (!hasScope(req.scope)) throw badRequest('Select at least one section, course or semester to study');
  const open = getOpenSession(ctx);
  if (open) {
    throw conflict('session_open', 'Another study session is still open. Resume or end it before starting a new one.', {
      sessionId: open.id,
    });
  }
  const seed = req.seed ?? Math.floor(ctx.random() * 0xffffffff) >>> 0;
  const { selected, preview } = computeSelection(ctx, { ...req }, seed);
  if (selected.length === 0) {
    throw new AppError(400, 'empty_selection', 'No cards match this selection. Choose another scope, mode or filter.', { preview });
  }
  if (selected.length < req.size && !req.acceptSmaller) {
    throw conflict('smaller_pool', `${selected.length} card${selected.length === 1 ? '' : 's'} available`, { preview });
  }
  const settings = getSettings(ctx);
  const maxAttempts = req.mode === 'test' ? 1 : req.maxAttempts;
  const queue = createQueue(
    selected.map((s) => s.id),
    maxAttempts,
  );
  const snapshot: SettingsSnapshot = {
    scheduler: settings.scheduler,
    schedulerVersion: getScheduler().version,
    timeZone: settings.timeZone,
    maxAttempts,
    scopeLabel: preview.scopeLabel,
  };
  const id = newId(ctx.now().getTime());
  const ts = nowIso(ctx);
  const db = ctx.db;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO study_sessions (id, mode, status, is_open, title, scope_json, filters_json, ordering, seed, requested_size,
         settings_json, scheduler_version, max_attempts, attempt_counter, next_queue_order, current_card_id,
         last_activity_at, started_at, updated_at)
       VALUES (?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      req.mode,
      req.title?.trim() || preview.scopeLabel,
      JSON.stringify(req.scope),
      JSON.stringify(req.filters),
      req.ordering,
      seed,
      req.size,
      JSON.stringify(snapshot),
      snapshot.schedulerVersion,
      maxAttempts,
      queue.nextQueueOrder,
      queue.currentCardId,
      ts,
      ts,
      ts,
    );
    const cardStmt = db.prepare(
      `SELECT c.*, s.title AS section_title, co.title AS course_title, co.color AS course_color, co.id AS course_id
       FROM cards c JOIN sections s ON s.id = c.section_id JOIN courses co ON co.id = s.course_id WHERE c.id = ?`,
    );
    const tags = cardTagsMap(ctx, selected.map((s) => s.id));
    const insert = db.prepare(
      `INSERT INTO session_cards (session_id, card_id, initial_position, queue_order, eligible_after, attempts, status,
         selection_reason, card_revision, snapshot_json, section_id, course_id)
       VALUES (?, ?, ?, ?, 0, 0, 'pending', ?, ?, ?, ?, ?)`,
    );
    selected.forEach((sel, i) => {
      const c = cardStmt.get(sel.id) as Record<string, string & number>;
      const snap: CardSnapshot = {
        front: c.front,
        back: c.back,
        explanation: c.explanation,
        hint: c.hint,
        source: c.source,
        tags: (tags.get(sel.id) ?? []).sort(),
        sectionTitle: c.section_title,
        courseTitle: c.course_title,
        courseColor: c.course_color,
      };
      insert.run(id, sel.id, i, i, sel.reason, c.revision, JSON.stringify(snap), c.section_id, c.course_id);
    });
  })();
  return getSessionState(ctx, id);
}

export function getSessionState(ctx: Ctx, id: string): SessionState {
  const s = getSessionRow(ctx, id);
  const cards = getSessionCards(ctx, id);
  const queue = toQueue(s, cards);
  const next = selectNext(queue);
  const open = s.status === 'active' || s.status === 'paused';
  let current: SessionState['current'] = null;
  if (open && s.current_card_id) {
    const row = cards.find((c) => c.card_id === s.current_card_id);
    if (row) {
      const live = ctx.db.prepare('SELECT revision FROM cards WHERE id = ?').get(row.card_id) as { revision: number } | undefined;
      current = {
        cardId: row.card_id,
        attempt: row.attempts + 1,
        isRepeat: row.attempts > 0,
        snapshot: snapshotOf(row),
        editedSinceStart: live ? live.revision !== row.card_revision : false,
      };
    }
  }
  const last = ctx.db
    .prepare(
      'SELECT card_id, rating FROM review_events WHERE session_id = ? AND undone_at IS NULL ORDER BY attempt_index DESC LIMIT 1',
    )
    .get(id) as { card_id: string; rating: number } | undefined;
  const lastCard = last ? cards.find((c) => c.card_id === last.card_id) : undefined;
  return {
    ...summaryOf(s, cards),
    revision: s.revision,
    maxAttempts: s.max_attempts,
    ordering: s.ordering,
    revealed: s.revealed === 1,
    hintShown: s.hint_shown === 1,
    typedAnswer: s.typed_answer,
    waiting: open && !s.current_card_id && next.waiting,
    relaxed: s.relaxed === 1,
    current,
    canUndo: Boolean(last),
    lastRating: last && lastCard ? { cardId: last.card_id, rating: last.rating as Rating, front: snapshotOf(lastCard).front } : null,
  };
}

/** Add elapsed active time since the last interaction (capped, excluding pauses). */
function accrue(ctx: Ctx, s: SessionRow): { activeMs: number; lastActivityAt: string } {
  const now = ctx.now().getTime();
  let active = s.active_ms;
  if (s.status === 'active' && s.last_activity_at) {
    const delta = now - Date.parse(s.last_activity_at);
    if (delta > 0) active += Math.min(delta, IDLE_CAP_MS);
  }
  return { activeMs: active, lastActivityAt: new Date(now).toISOString() };
}

function assertRevision(s: SessionRow, revision: unknown) {
  if (revision !== undefined && revision !== s.revision) {
    throw conflict('stale_session', 'This session changed in another tab or window. The latest state has been loaded.');
  }
}

function assertOpen(s: SessionRow) {
  if (s.status !== 'active' && s.status !== 'paused') throw conflict('session_closed', 'This session has already finished');
}

const revealSchema = z.object({
  revision: z.number().int().optional(),
  typedAnswer: z.string().max(20000).optional(),
});

export function reveal(ctx: Ctx, id: string, input: unknown): SessionState {
  const data = parse(revealSchema, input ?? {});
  ctx.db.transaction(() => {
    const s = getSessionRow(ctx, id);
    assertOpen(s);
    if (s.revealed === 1) return; // idempotent
    assertRevision(s, data.revision);
    if (!s.current_card_id) throw conflict('no_current_card', 'There is no card to reveal right now');
    const t = accrue(ctx, s);
    ctx.db
      .prepare(
        `UPDATE study_sessions SET revealed = 1, typed_answer = ?, status = 'active', active_ms = ?, last_activity_at = ?,
           revision = revision + 1, updated_at = ? WHERE id = ?`,
      )
      .run(data.typedAnswer ?? s.typed_answer, t.activeMs, t.lastActivityAt, nowIso(ctx), id);
  })();
  return getSessionState(ctx, id);
}

export function showHint(ctx: Ctx, id: string): SessionState {
  const s = getSessionRow(ctx, id);
  assertOpen(s);
  ctx.db
    .prepare('UPDATE study_sessions SET hint_shown = 1, revision = revision + 1, updated_at = ? WHERE id = ? AND hint_shown = 0')
    .run(nowIso(ctx), id);
  return getSessionState(ctx, id);
}

const rateSchema = z.object({
  rating: z.number().int().refine(isRating, 'Rating must be 1–4'),
  idempotencyKey: z.string().min(8).max(100),
  revision: z.number().int().optional(),
  cardId: zId.optional(),
});

function scheduleRowToState(r: ScheduleRow | undefined): ScheduleState | null {
  if (!r) return null;
  return {
    dueDate: r.due_date,
    intervalDays: r.interval_days,
    reviewCount: r.review_count,
    lapseCount: r.lapse_count,
    firstReviewedAt: r.first_reviewed_at,
    lastReviewedAt: r.last_reviewed_at,
    lastRating: r.last_rating as Rating,
    schedulerVersion: r.scheduler_version,
  };
}

function writeSchedule(ctx: Ctx, cardId: string, s: ScheduleState | null) {
  if (!s) {
    ctx.db.prepare('DELETE FROM card_schedules WHERE card_id = ?').run(cardId);
    return;
  }
  ctx.db
    .prepare(
      `INSERT INTO card_schedules (card_id, due_date, interval_days, review_count, lapse_count, first_reviewed_at, last_reviewed_at, last_rating, scheduler_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(card_id) DO UPDATE SET due_date = excluded.due_date, interval_days = excluded.interval_days,
         review_count = excluded.review_count, lapse_count = excluded.lapse_count, first_reviewed_at = excluded.first_reviewed_at,
         last_reviewed_at = excluded.last_reviewed_at, last_rating = excluded.last_rating,
         scheduler_version = excluded.scheduler_version, updated_at = excluded.updated_at`,
    )
    .run(cardId, s.dueDate, s.intervalDays, s.reviewCount, s.lapseCount, s.firstReviewedAt, s.lastReviewedAt, s.lastRating, s.schedulerVersion, nowIso(ctx));
}

export interface RateResponse {
  state: SessionState;
  replayed: boolean;
  outcome?: 'requeued' | 'completed' | 'unresolved';
  scheduleAfter?: ScheduleState | null;
}

export function rateCard(ctx: Ctx, id: string, input: unknown): RateResponse {
  const data = parse(rateSchema, input);
  const rating = data.rating as Rating;
  const db = ctx.db;
  let outcome: RateResponse['outcome'];
  let scheduleAfter: ScheduleState | null = null;
  let replayed = false;
  db.transaction(() => {
    const prior = db.prepare('SELECT session_id FROM review_events WHERE idempotency_key = ?').get(data.idempotencyKey) as
      | { session_id: string }
      | undefined;
    if (prior) {
      if (prior.session_id !== id) throw conflict('idempotency_mismatch', 'This rating key belongs to another session');
      replayed = true;
      return;
    }
    const s = getSessionRow(ctx, id);
    assertOpen(s);
    if (s.status === 'paused') throw conflict('session_paused', 'Resume the session before rating');
    assertRevision(s, data.revision);
    if (!s.current_card_id) throw conflict('no_current_card', 'There is no card to rate right now');
    if (data.cardId && data.cardId !== s.current_card_id) {
      throw conflict('stale_session', 'The current card changed. The latest state has been loaded.');
    }
    if (s.revealed !== 1) throw badRequest('Reveal the answer before rating');

    const cards = getSessionCards(ctx, id);
    const cardRow = cards.find((c) => c.card_id === s.current_card_id)!;
    const queue = toQueue(s, cards);
    const result = queueRate(queue, s.current_card_id, rating);
    outcome = result.outcome;
    const updated = result.state.entries.find((e) => e.cardId === cardRow.card_id)!;

    const snap = parseJson<SettingsSnapshot>(s.settings_json, {} as SettingsSnapshot);
    const affectsSchedule = s.mode === 'scheduled' && result.isFirstAttempt;
    const beforeRow = db.prepare('SELECT * FROM card_schedules WHERE card_id = ?').get(cardRow.card_id) as ScheduleRow | undefined;
    const before = scheduleRowToState(beforeRow);
    if (affectsSchedule) {
      const scheduler = getScheduler(snap.schedulerVersion ?? s.scheduler_version);
      scheduleAfter = scheduler.next({
        previous: before,
        rating,
        reviewedAt: ctx.now(),
        timeZone: snap.timeZone ?? getSettings(ctx).timeZone,
        settings: normalizeSchedulerSettings(snap.scheduler),
      });
      writeSchedule(ctx, cardRow.card_id, scheduleAfter);
    }

    const t = accrue(ctx, s);
    const undo: UndoPayload = {
      session: {
        attempt_counter: s.attempt_counter,
        next_queue_order: s.next_queue_order,
        current_card_id: s.current_card_id,
        revealed: s.revealed,
        hint_shown: s.hint_shown,
        typed_answer: s.typed_answer,
        relaxed: s.relaxed,
        status: s.status,
        is_open: s.is_open,
        finished_at: s.finished_at,
      },
      card: cardRow,
    };
    const ts = nowIso(ctx);
    db.prepare(
      `INSERT INTO review_events (id, session_id, card_id, mode, rating, rated_at, attempt_index, card_attempt, is_first_attempt,
         affects_schedule, schedule_before_json, schedule_after_json, undo_json, idempotency_key, active_ms, typed_answer, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(ctx.now().getTime()),
      id,
      cardRow.card_id,
      s.mode,
      rating,
      ts,
      result.attemptIndex,
      result.cardAttempt,
      result.isFirstAttempt ? 1 : 0,
      affectsSchedule ? 1 : 0,
      before ? JSON.stringify(before) : null,
      affectsSchedule ? JSON.stringify(scheduleAfter) : null,
      JSON.stringify(undo),
      data.idempotencyKey,
      t.activeMs - s.active_ms_marked,
      s.typed_answer,
      ts,
    );
    db.prepare(
      `UPDATE session_cards SET queue_order = ?, eligible_after = ?, attempts = ?, status = ?, first_rating = ?, final_rating = ?
       WHERE session_id = ? AND card_id = ?`,
    ).run(updated.queueOrder, updated.eligibleAfter, updated.attempts, updated.status, updated.firstRating, updated.finalRating, id, cardRow.card_id);
    const finished = selectNext(result.state).finished;
    db.prepare(
      `UPDATE study_sessions SET attempt_counter = ?, next_queue_order = ?, current_card_id = ?, revealed = 0, hint_shown = 0,
         typed_answer = '', status = ?, is_open = ?, finished_at = ?, active_ms = ?, active_ms_marked = ?, last_activity_at = ?,
         revision = revision + 1, updated_at = ? WHERE id = ?`,
    ).run(
      result.state.attemptCounter,
      result.state.nextQueueOrder,
      result.state.currentCardId,
      finished ? 'completed' : 'active',
      finished ? null : 1,
      finished ? ts : null,
      t.activeMs,
      t.activeMs,
      t.lastActivityAt,
      ts,
      id,
    );
  })();
  return { state: getSessionState(ctx, id), replayed, outcome, scheduleAfter };
}

export function undoLast(ctx: Ctx, id: string, input: unknown): SessionState {
  const data = parse(z.object({ revision: z.number().int().optional() }), input ?? {});
  const db = ctx.db;
  db.transaction(() => {
    const s = getSessionRow(ctx, id);
    assertRevision(s, data.revision);
    const ev = db
      .prepare('SELECT * FROM review_events WHERE session_id = ? AND undone_at IS NULL ORDER BY attempt_index DESC LIMIT 1')
      .get(id) as
      | { id: string; card_id: string; affects_schedule: number; schedule_before_json: string | null; schedule_after_json: string | null; undo_json: string }
      | undefined;
    if (!ev) throw badRequest('There is no rating to undo in this session');
    const undo = parseJson<UndoPayload>(ev.undo_json, null as unknown as UndoPayload);
    if (!undo) throw new AppError(500, 'corrupt_undo', 'Undo information is missing for this rating');
    if (undo.session.is_open === 1 && s.is_open !== 1) {
      const other = db.prepare('SELECT id FROM study_sessions WHERE is_open = 1 AND id != ?').get(id);
      if (other) throw conflict('session_open', 'Another session is open now, so this finished session cannot be reopened');
    }
    if (ev.affects_schedule === 1) {
      const nowRow = db.prepare('SELECT * FROM card_schedules WHERE card_id = ?').get(ev.card_id) as ScheduleRow | undefined;
      const current = scheduleRowToState(nowRow);
      const after = parseJson<ScheduleState | null>(ev.schedule_after_json, null);
      if (JSON.stringify(current) !== JSON.stringify(after)) {
        throw conflict('schedule_changed', 'This card has been reviewed again since, so this rating can no longer be undone');
      }
      writeSchedule(ctx, ev.card_id, parseJson<ScheduleState | null>(ev.schedule_before_json, null));
    }
    const c = undo.card;
    db.prepare(
      `UPDATE session_cards SET queue_order = ?, eligible_after = ?, attempts = ?, status = ?, first_rating = ?, final_rating = ?
       WHERE session_id = ? AND card_id = ?`,
    ).run(c.queue_order, c.eligible_after, c.attempts, c.status, c.first_rating, c.final_rating, id, c.card_id);
    const u = undo.session;
    db.prepare(
      `UPDATE study_sessions SET attempt_counter = ?, next_queue_order = ?, current_card_id = ?, revealed = ?, hint_shown = ?,
         typed_answer = ?, relaxed = ?, status = ?, is_open = ?, finished_at = ?, last_activity_at = ?, revision = revision + 1, updated_at = ?
       WHERE id = ?`,
    ).run(
      u.attempt_counter,
      u.next_queue_order,
      u.current_card_id,
      u.revealed,
      u.hint_shown,
      u.typed_answer,
      u.relaxed,
      u.status === 'paused' ? 'active' : u.status,
      u.is_open,
      u.finished_at,
      nowIso(ctx),
      nowIso(ctx),
      id,
    );
    db.prepare('UPDATE review_events SET undone_at = ? WHERE id = ?').run(nowIso(ctx), ev.id);
  })();
  return getSessionState(ctx, id);
}

export function relaxGap(ctx: Ctx, id: string, input: unknown): SessionState {
  const data = parse(z.object({ revision: z.number().int().optional() }), input ?? {});
  ctx.db.transaction(() => {
    const s = getSessionRow(ctx, id);
    assertOpen(s);
    assertRevision(s, data.revision);
    if (s.current_card_id) return;
    const next = queueRelax(toQueue(s, getSessionCards(ctx, id)));
    ctx.db
      .prepare('UPDATE study_sessions SET relaxed = 1, current_card_id = ?, revealed = 0, revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(next.currentCardId, nowIso(ctx), id);
  })();
  return getSessionState(ctx, id);
}

export function pauseSession(ctx: Ctx, id: string): SessionState {
  ctx.db.transaction(() => {
    const s = getSessionRow(ctx, id);
    assertOpen(s);
    if (s.status === 'paused') return;
    const t = accrue(ctx, s);
    ctx.db
      .prepare("UPDATE study_sessions SET status = 'paused', active_ms = ?, last_activity_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(t.activeMs, t.lastActivityAt, nowIso(ctx), id);
  })();
  return getSessionState(ctx, id);
}

export function resumeSession(ctx: Ctx, id: string): SessionState {
  const s = getSessionRow(ctx, id);
  assertOpen(s);
  if (s.status === 'paused') {
    ctx.db
      .prepare("UPDATE study_sessions SET status = 'active', last_activity_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(nowIso(ctx), nowIso(ctx), id);
  }
  return getSessionState(ctx, id);
}

export function endSession(ctx: Ctx, id: string): SessionState {
  ctx.db.transaction(() => {
    const s = getSessionRow(ctx, id);
    assertOpen(s);
    const t = accrue(ctx, s);
    const ts = nowIso(ctx);
    ctx.db
      .prepare(
        "UPDATE study_sessions SET status = 'ended', is_open = NULL, finished_at = ?, current_card_id = NULL, revealed = 0, active_ms = ?, last_activity_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      )
      .run(ts, t.activeMs, t.lastActivityAt, ts, id);
  })();
  return getSessionState(ctx, id);
}

export function sessionResults(ctx: Ctx, id: string): SessionResults {
  const s = getSessionRow(ctx, id);
  const cards = getSessionCards(ctx, id);
  const zero = (): Record<Rating, number> => ({ 1: 0, 2: 0, 3: 0, 4: 0 });
  const firstRatingCounts = zero();
  const finalRatingCounts = zero();
  const bySection = new Map<string, SessionResults['bySection'][number]>();
  const out: SessionResults['cards'] = [];
  for (const c of cards) {
    const snap = snapshotOf(c);
    if (c.first_rating) firstRatingCounts[c.first_rating as Rating]++;
    if (c.final_rating) finalRatingCounts[c.final_rating as Rating]++;
    out.push({
      cardId: c.card_id,
      front: snap.front,
      sectionId: c.section_id,
      sectionTitle: snap.sectionTitle,
      courseTitle: snap.courseTitle,
      attempts: c.attempts,
      firstRating: (c.first_rating ?? null) as Rating | null,
      finalRating: (c.final_rating ?? null) as Rating | null,
      status: c.status,
    });
    const sec = bySection.get(c.section_id) ?? {
      sectionId: c.section_id,
      sectionTitle: snap.sectionTitle,
      courseTitle: snap.courseTitle,
      cards: 0,
      firstRecalled: 0,
      unresolved: 0,
      attempts: 0,
    };
    sec.cards++;
    sec.attempts += c.attempts;
    if (c.first_rating === 3 || c.first_rating === 4) sec.firstRecalled++;
    if (c.status === 'unresolved') sec.unresolved++;
    bySection.set(c.section_id, sec);
  }
  const attempted = cards.filter((c) => c.attempts > 0).length;
  return {
    session: summaryOf(s, cards),
    firstRatingCounts,
    finalRatingCounts,
    repeatAttempts: s.attempt_counter - attempted,
    notReached: cards.filter((c) => c.attempts === 0).length,
    cards: out,
    bySection: [...bySection.values()],
    weakCardIds: cards
      .filter((c) => c.status === 'unresolved' || c.first_rating === 1 || c.first_rating === 2)
      .map((c) => c.card_id),
  };
}

export type { SessionFilters };
