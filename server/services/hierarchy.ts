import { z } from 'zod';
import { COURSE_COLORS, COURSE_ICONS, SECTION_KINDS } from '../../shared/catalog.ts';
import { examReviewDeadline } from '../../shared/exam-planner.ts';
import type {
  Counts,
  Crumb,
  ImpactCounts,
  Level,
  TrashItem,
  TrashType,
  TreeCourse,
  TreeProgram,
  TreeSection,
  TreeSemester,
} from '../../shared/types.ts';
import { nowIso, type Ctx } from '../context.ts';
import { AppError, badRequest, conflict, newId, notFound, placeholders } from '../lib/util.ts';
import { parse, zId, zOptDate, zText, zTitle } from '../lib/validate.ts';
import {
  toCourse,
  toProgram,
  toSection,
  toSemester,
  type CardRow,
  type CourseRow,
  type ProgramRow,
  type SectionRow,
  type SemesterRow,
} from './mappers.ts';
import { noteDisplayTitle, restoreNote, trashNote, type NoteRow } from './notes.ts';
import { getSettings } from './settings.ts';
import { today } from './time.ts';

interface LevelDef {
  table: string;
  parentCol: string | null;
  parentLevel: Level | null;
  label: string;
}

export const LEVELS: Record<Level, LevelDef> = {
  program: { table: 'programs', parentCol: null, parentLevel: null, label: 'Study program' },
  semester: { table: 'semesters', parentCol: 'program_id', parentLevel: 'program', label: 'Semester' },
  course: { table: 'courses', parentCol: 'semester_id', parentLevel: 'semester', label: 'Course' },
  section: { table: 'sections', parentCol: 'course_id', parentLevel: 'course', label: 'Section' },
};

export function isLevel(v: string): v is Level {
  return v in LEVELS;
}

// ---------- Validation ----------

const programFields = z.object({ title: zTitle, description: zText(5000).optional() });
const semesterFields = z.object({
  title: zTitle,
  startDate: zOptDate,
  endDate: zOptDate,
});
const courseFields = z.object({
  title: zTitle,
  moduleCode: zText(60).optional(),
  color: z.enum(COURSE_COLORS).optional(),
  icon: z.enum(COURSE_ICONS).optional(),
  description: zText(10000).optional(),
  examDate: zOptDate,
});
const sectionFields = z.object({
  title: zTitle,
  kind: z.enum(SECTION_KINDS.map((k) => k.value) as [string, ...string[]]).optional(),
  weekNumber: z.union([z.number().int().min(0).max(999), z.null()]).optional(),
  date: zOptDate,
  notes: zText(50000).optional(),
});

const COLUMN_MAP: Record<string, string> = {
  title: 'title',
  description: 'description',
  startDate: 'start_date',
  endDate: 'end_date',
  moduleCode: 'module_code',
  color: 'color',
  icon: 'icon',
  examDate: 'exam_date',
  kind: 'kind',
  weekNumber: 'week_number',
  date: 'date',
  notes: 'notes',
};

const FIELD_SCHEMAS: Record<Level, z.ZodObject> = {
  program: programFields,
  semester: semesterFields,
  course: courseFields,
  section: sectionFields,
};

// ---------- Reads ----------

export function getRow<T>(ctx: Ctx, level: Level, id: string): T {
  const row = ctx.db.prepare(`SELECT * FROM ${LEVELS[level].table} WHERE id = ?`).get(id) as T | undefined;
  if (!row) throw notFound(LEVELS[level].label);
  return row;
}

function emptyCounts(): Counts {
  return { total: 0, due: 0, new: 0, suspended: 0 };
}

function addCounts(into: Counts, c: Counts) {
  into.total += c.total;
  into.due += c.due;
  into.new += c.new;
  into.suspended += c.suspended;
}

export function sectionCounts(ctx: Ctx, sectionIds?: string[]): Map<string, Counts> {
  const where = sectionIds ? `AND c.section_id IN (${placeholders(sectionIds.length)})` : '';
  const rows = ctx.db
    .prepare(
      `SELECT c.section_id AS sid, COUNT(*) AS total,
        SUM(CASE WHEN c.suspended_at IS NULL AND cs.card_id IS NULL THEN 1 ELSE 0 END) AS new,
        SUM(CASE WHEN c.suspended_at IS NULL AND cs.due_date <= ? THEN 1 ELSE 0 END) AS due,
        SUM(CASE WHEN c.suspended_at IS NOT NULL THEN 1 ELSE 0 END) AS suspended
       FROM cards c LEFT JOIN card_schedules cs ON cs.card_id = c.id
       WHERE c.deleted_at IS NULL ${where}
       GROUP BY c.section_id`,
    )
    .all(today(ctx), ...(sectionIds ?? [])) as (Counts & { sid: string })[];
  return new Map(rows.map((r) => [r.sid, { total: r.total, due: r.due, new: r.new, suspended: r.suspended }]));
}

export function getTree(ctx: Ctx, opts: { includeArchived?: boolean } = {}): TreeProgram[] {
  const arch = opts.includeArchived ? '' : 'AND archived_at IS NULL';
  const db = ctx.db;
  const programs = db
    .prepare(`SELECT * FROM programs WHERE deleted_at IS NULL ${arch} ORDER BY position, created_at`)
    .all() as ProgramRow[];
  const semesters = db
    .prepare(`SELECT * FROM semesters WHERE deleted_at IS NULL ${arch} ORDER BY position, created_at`)
    .all() as SemesterRow[];
  const courses = db
    .prepare(`SELECT * FROM courses WHERE deleted_at IS NULL ${arch} ORDER BY position, created_at`)
    .all() as CourseRow[];
  const sections = db
    .prepare(`SELECT * FROM sections WHERE deleted_at IS NULL ${arch} ORDER BY position, created_at`)
    .all() as SectionRow[];
  const counts = sectionCounts(ctx);

  const secByCourse = new Map<string, TreeSection[]>();
  for (const s of sections) {
    const list = secByCourse.get(s.course_id) ?? [];
    list.push({ ...toSection(s), counts: counts.get(s.id) ?? emptyCounts() });
    secByCourse.set(s.course_id, list);
  }
  const courseBySem = new Map<string, TreeCourse[]>();
  for (const c of courses) {
    const secs = secByCourse.get(c.id) ?? [];
    const cc = emptyCounts();
    for (const s of secs) if (!s.archivedAt) addCounts(cc, s.counts);
    const list = courseBySem.get(c.semester_id) ?? [];
    list.push({ ...toCourse(c), counts: cc, sections: secs });
    courseBySem.set(c.semester_id, list);
  }
  const semByProg = new Map<string, TreeSemester[]>();
  for (const s of semesters) {
    const cs = courseBySem.get(s.id) ?? [];
    const sc = emptyCounts();
    for (const c of cs) if (!c.archivedAt) addCounts(sc, c.counts);
    const list = semByProg.get(s.program_id) ?? [];
    list.push({ ...toSemester(s), counts: sc, courses: cs });
    semByProg.set(s.program_id, list);
  }
  return programs.map((p) => {
    const sems = semByProg.get(p.id) ?? [];
    const pc = emptyCounts();
    for (const s of sems) if (!s.archivedAt) addCounts(pc, s.counts);
    return { ...toProgram(p), counts: pc, semesters: sems };
  });
}

export function breadcrumbs(ctx: Ctx, level: Level, id: string): Crumb[] {
  const crumbs: Crumb[] = [];
  let curLevel: Level | null = level;
  let curId: string | null = id;
  while (curLevel && curId) {
    const def: LevelDef = LEVELS[curLevel];
    const row = ctx.db.prepare(`SELECT * FROM ${def.table} WHERE id = ?`).get(curId) as
      | Record<string, string>
      | undefined;
    if (!row) break;
    crumbs.unshift({ id: row.id, title: row.title, level: curLevel });
    curId = def.parentCol ? row[def.parentCol] : null;
    curLevel = def.parentLevel;
  }
  return crumbs;
}

/** Whether an item or any ancestor is deleted / archived. */
export function itemState(ctx: Ctx, level: Level, id: string): { inTrash: boolean; inArchive: boolean } {
  let inTrash = false;
  let inArchive = false;
  let curLevel: Level | null = level;
  let curId: string | null = id;
  while (curLevel && curId) {
    const def: LevelDef = LEVELS[curLevel];
    const row = ctx.db.prepare(`SELECT * FROM ${def.table} WHERE id = ?`).get(curId) as
      | Record<string, string | null>
      | undefined;
    if (!row) break;
    if (row.deleted_at) inTrash = true;
    if (row.archived_at) inArchive = true;
    curId = def.parentCol ? (row[def.parentCol] as string) : null;
    curLevel = def.parentLevel;
  }
  return { inTrash, inArchive };
}

// ---------- Writes ----------

function nextPosition(ctx: Ctx, level: Level, parentId: string | null): number {
  const def = LEVELS[level];
  const row = def.parentCol
    ? (ctx.db.prepare(`SELECT MAX(position) AS m FROM ${def.table} WHERE ${def.parentCol} = ?`).get(parentId) as {
        m: number | null;
      })
    : (ctx.db.prepare(`SELECT MAX(position) AS m FROM ${def.table}`).get() as { m: number | null });
  return (row.m ?? -1) + 1;
}

export function assertParentUsable(ctx: Ctx, level: Level, parentId: string) {
  const st = itemState(ctx, level, parentId);
  if (st.inTrash) throw badRequest(`The target ${LEVELS[level].label.toLowerCase()} is in the trash`);
}

function assertNotInTrash(ctx: Ctx, level: Level, id: string, action: string) {
  if (itemState(ctx, level, id).inTrash) {
    throw badRequest(`Restore this ${LEVELS[level].label.toLowerCase()} from the trash before ${action} it`);
  }
}

export function createItem(ctx: Ctx, level: Level, input: Record<string, unknown>, opts: { isDemo?: boolean } = {}) {
  const def = LEVELS[level];
  const fields = parse(FIELD_SCHEMAS[level], input) as Record<string, unknown>;
  let parentId: string | null = null;
  if (def.parentLevel && def.parentCol) {
    const parentKey = `${def.parentLevel}Id`;
    parentId = parse(zId, input[parentKey]);
    getRow(ctx, def.parentLevel, parentId);
    assertParentUsable(ctx, def.parentLevel, parentId);
  }
  const id = newId(ctx.now().getTime());
  const ts = nowIso(ctx);
  const cols: string[] = ['id', 'position', 'is_demo', 'created_at', 'updated_at'];
  const vals: unknown[] = [id, nextPosition(ctx, level, parentId), opts.isDemo ? 1 : 0, ts, ts];
  if (def.parentCol) {
    cols.push(def.parentCol);
    vals.push(parentId);
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    cols.push(COLUMN_MAP[k]);
    vals.push(v);
  }
  if (level === 'semester') validateDates(fields.startDate as string | null, fields.endDate as string | null);
  ctx.db
    .prepare(`INSERT INTO ${def.table} (${cols.join(',')}) VALUES (${placeholders(cols.length)})`)
    .run(...vals);
  if (level === 'course' && fields.examDate) {
    ctx.db.prepare('UPDATE courses SET exam_set_at = ? WHERE id = ?').run(ts, id);
  }
  return getItem(ctx, level, id);
}

function validateDates(start: string | null | undefined, end: string | null | undefined) {
  if (start && end && end < start) throw badRequest('The end date must be on or after the start date');
}

export function getItem(ctx: Ctx, level: Level, id: string) {
  switch (level) {
    case 'program':
      return toProgram(getRow<ProgramRow>(ctx, 'program', id));
    case 'semester':
      return toSemester(getRow<SemesterRow>(ctx, 'semester', id));
    case 'course':
      return toCourse(getRow<CourseRow>(ctx, 'course', id));
    case 'section':
      return toSection(getRow<SectionRow>(ctx, 'section', id));
  }
}

export function updateItem(ctx: Ctx, level: Level, id: string, input: Record<string, unknown>) {
  const def = LEVELS[level];
  const existing = getRow<Record<string, unknown>>(ctx, level, id);
  if (existing.deleted_at) throw badRequest('Restore this item from the trash before editing it');
  const partial = FIELD_SCHEMAS[level].partial();
  const fields = parse(partial, input) as Record<string, unknown>;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(`${COLUMN_MAP[k]} = ?`);
    vals.push(v);
  }
  const examDateChanged = level === 'course' && fields.examDate !== undefined && fields.examDate !== existing.exam_date;
  if (examDateChanged) {
    sets.push('exam_set_at = ?');
    vals.push(fields.examDate ? nowIso(ctx) : null);
  }
  if (typeof input.archived === 'boolean') {
    sets.push('archived_at = ?');
    vals.push(input.archived ? nowIso(ctx) : null);
  }
  if (level === 'semester') {
    const start = fields.startDate !== undefined ? fields.startDate : existing.start_date;
    const end = fields.endDate !== undefined ? fields.endDate : existing.end_date;
    validateDates(start as string | null, end as string | null);
  }
  if (sets.length === 0) return getItem(ctx, level, id);
  sets.push('updated_at = ?');
  vals.push(nowIso(ctx));
  ctx.db.prepare(`UPDATE ${def.table} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  if (examDateChanged && typeof fields.examDate === 'string') {
    const deadline = examReviewDeadline(fields.examDate, today(ctx));
    if (deadline) {
      ctx.db
        .prepare(
          `UPDATE card_schedules
           SET due_date = ?, updated_at = ?
           WHERE due_date > ?
             AND card_id IN (
               SELECT cards.id
               FROM cards
               JOIN sections ON sections.id = cards.section_id
               WHERE sections.course_id = ?
             )`,
        )
        .run(deadline, nowIso(ctx), deadline, id);
    }
  }
  return getItem(ctx, level, id);
}

export function reorder(ctx: Ctx, level: Level, parentId: string | null, ids: string[]) {
  const def = LEVELS[level];
  parse(z.array(zId).max(5000), ids);
  const siblings = (
    def.parentCol
      ? ctx.db
          .prepare(`SELECT id FROM ${def.table} WHERE ${def.parentCol} = ? ORDER BY position, created_at`)
          .all(parentId)
      : ctx.db.prepare(`SELECT id FROM ${def.table} ORDER BY position, created_at`).all()
  ) as { id: string }[];
  const siblingIds = new Set(siblings.map((s) => s.id));
  for (const id of ids) if (!siblingIds.has(id)) throw badRequest('All reordered items must share the same parent');
  const listed = new Set(ids);
  const finalOrder = [...ids, ...siblings.map((s) => s.id).filter((id) => !listed.has(id))];
  const stmt = ctx.db.prepare(`UPDATE ${def.table} SET position = ?, updated_at = ? WHERE id = ?`);
  const ts = nowIso(ctx);
  ctx.db.transaction(() => finalOrder.forEach((id, i) => stmt.run(i, ts, id)))();
}

/** Move a section to another course, or a course to another semester. Card history is unaffected. */
export function moveItem(ctx: Ctx, level: 'section' | 'course', id: string, targetParentId: string) {
  const def = LEVELS[level];
  const parentLevel = def.parentLevel as Level;
  getRow(ctx, level, id);
  assertNotInTrash(ctx, level, id, 'moving');
  getRow(ctx, parentLevel, targetParentId);
  assertParentUsable(ctx, parentLevel, targetParentId);
  ctx.db
    .prepare(`UPDATE ${def.table} SET ${def.parentCol} = ?, position = ?, updated_at = ? WHERE id = ?`)
    .run(targetParentId, nextPosition(ctx, level, targetParentId), nowIso(ctx), id);
  return getItem(ctx, level, id);
}

// ---------- Impact, trash and deletion ----------

const SCOPE_COL: Record<TrashType, string> = {
  program: 'program_id',
  semester: 'semester_id',
  course: 'course_id',
  section: 'section_id',
  card: 'id',
};

export function impactOf(ctx: Ctx, type: TrashType, id: string): ImpactCounts {
  const db = ctx.db;
  if (type === 'card') {
    // Deleting a card deletes its note, so the impact covers every card the note generated.
    const note = `(SELECT note_id FROM cards WHERE id = ?)`;
    const n = (sql: string) => (db.prepare(sql).get(id) as { n: number }).n;
    return {
      semesters: 0,
      courses: 0,
      sections: 0,
      cards: n(`SELECT COUNT(*) AS n FROM cards WHERE note_id = ${note} AND retired_at IS NULL`),
      reviews: n(`SELECT COUNT(*) AS n FROM review_events re JOIN cards c ON c.id = re.card_id WHERE c.note_id = ${note} AND re.undone_at IS NULL`),
      openSessionCards: n(
        `SELECT COUNT(*) AS n FROM session_cards sc JOIN study_sessions s ON s.id = sc.session_id AND s.is_open = 1
         JOIN cards c ON c.id = sc.card_id WHERE c.note_id = ${note}`,
      ),
    };
  }
  const col = SCOPE_COL[type];
  const one = (sql: string) => (db.prepare(sql).get(id) as { n: number }).n;
  const semesters = type === 'program' ? one('SELECT COUNT(*) AS n FROM semesters WHERE program_id = ?') : 0;
  const courses =
    type === 'program'
      ? one('SELECT COUNT(*) AS n FROM courses co JOIN semesters se ON se.id = co.semester_id WHERE se.program_id = ?')
      : type === 'semester'
        ? one('SELECT COUNT(*) AS n FROM courses WHERE semester_id = ?')
        : 0;
  const sections =
    type === 'section' ? 0 : one(`SELECT COUNT(*) AS n FROM section_ctx WHERE ${col === 'section_id' ? 'id' : col} = ?`);
  const cards = one(`SELECT COUNT(*) AS n FROM card_ctx WHERE ${col} = ?`);
  const reviews = one(
    `SELECT COUNT(*) AS n FROM review_events re JOIN card_ctx c ON c.id = re.card_id WHERE c.${col} = ? AND re.undone_at IS NULL`,
  );
  const openSessionCards = one(
    `SELECT COUNT(*) AS n FROM session_cards sc
     JOIN study_sessions s ON s.id = sc.session_id AND s.is_open = 1
     JOIN card_ctx c ON c.id = sc.card_id WHERE c.${col} = ?`,
  );
  return { semesters, courses, sections, cards, reviews, openSessionCards };
}

function assertNotInOpenSession(ctx: Ctx, type: TrashType, id: string) {
  const impact = impactOf(ctx, type, id);
  if (impact.openSessionCards > 0) {
    throw conflict(
      'in_open_session',
      `${impact.openSessionCards} card(s) here belong to the study session that is still open. Finish or end that session first.`,
    );
  }
}

const TRASH_TABLE: Record<TrashType, string> = {
  program: 'programs',
  semester: 'semesters',
  course: 'courses',
  section: 'sections',
  card: 'cards',
};

export function moveToTrash(ctx: Ctx, type: TrashType, id: string) {
  if (type === 'card') {
    const row = ctx.db.prepare('SELECT n.id, n.deleted_at FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.id = ?').get(id) as
      | { id: string; deleted_at: string | null }
      | undefined;
    if (!row) throw notFound('Item');
    if (row.deleted_at) return;
    assertNotInOpenSession(ctx, type, id);
    ctx.db.transaction(() => trashNote(ctx, row.id))();
    return;
  }
  const table = TRASH_TABLE[type];
  const row = ctx.db.prepare(`SELECT id, deleted_at FROM ${table} WHERE id = ?`).get(id) as
    | { id: string; deleted_at: string | null }
    | undefined;
  if (!row) throw notFound('Item');
  if (row.deleted_at) return;
  assertNotInOpenSession(ctx, type, id);
  ctx.db.prepare(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(nowIso(ctx), nowIso(ctx), id);
}

export function restoreFromTrash(ctx: Ctx, type: TrashType, id: string) {
  if (type === 'card') {
    const noteId = (ctx.db.prepare('SELECT note_id FROM cards WHERE id = ?').get(id) as { note_id: string } | undefined)?.note_id;
    if (!noteId || !ctx.db.transaction(() => restoreNote(ctx, noteId))()) throw notFound('Item in trash');
    return;
  }
  const table = TRASH_TABLE[type];
  const r = ctx.db.prepare(`UPDATE ${table} SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL`).run(nowIso(ctx), id);
  if (r.changes === 0) throw notFound('Item in trash');
}

export function purge(ctx: Ctx, type: TrashType, id: string) {
  if (type === 'card') {
    const row = ctx.db.prepare('SELECT n.id, n.deleted_at FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.id = ?').get(id) as
      | { id: string; deleted_at: string | null }
      | undefined;
    if (!row) throw notFound('Item');
    if (!row.deleted_at) throw badRequest('Only items in the trash can be deleted permanently');
    assertNotInOpenSession(ctx, type, id);
    ctx.db.transaction(() => {
      ctx.db.prepare('DELETE FROM notes WHERE id = ?').run(row.id); // cards, schedules and history cascade
      removeOrphanTags(ctx);
    })();
    return;
  }
  const table = TRASH_TABLE[type];
  const row = ctx.db.prepare(`SELECT deleted_at FROM ${table} WHERE id = ?`).get(id) as
    | { deleted_at: string | null }
    | undefined;
  if (!row) throw notFound('Item');
  if (!row.deleted_at) throw badRequest('Only items in the trash can be deleted permanently');
  assertNotInOpenSession(ctx, type, id);
  ctx.db.transaction(() => {
    ctx.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    removeOrphanTags(ctx);
  })();
}

export function removeOrphanTags(ctx: Ctx) {
  ctx.db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM card_tags)').run();
}

export function emptyTrash(ctx: Ctx): number {
  const items = listTrash(ctx);
  let n = 0;
  for (const item of items) {
    if (item.impact.openSessionCards > 0) continue;
    const exists = ctx.db.prepare(`SELECT 1 FROM ${TRASH_TABLE[item.type]} WHERE id = ?`).get(item.id);
    if (!exists) continue; // already removed with an ancestor
    purge(ctx, item.type, item.id);
    n++;
  }
  return n;
}

export function listTrash(ctx: Ctx): TrashItem[] {
  const items: TrashItem[] = [];
  const db = ctx.db;
  const push = (type: TrashType, rows: { id: string; title: string; deleted_at: string }[], parentLevel: Level | null, parentOf: (id: string) => string | null) => {
    for (const r of rows) {
      const parentId = parentOf(r.id);
      const crumbs = parentLevel && parentId ? breadcrumbs(ctx, parentLevel, parentId) : [];
      const parentInTrash = parentLevel && parentId ? itemState(ctx, parentLevel, parentId).inTrash : false;
      items.push({
        type,
        id: r.id,
        title: r.title,
        deletedAt: r.deleted_at,
        context: crumbs.map((c) => c.title).join(' › '),
        parentInTrash,
        impact: impactOf(ctx, type, r.id),
      });
    }
  };
  const parentLookup = (table: string, col: string) => (id: string) =>
    (db.prepare(`SELECT ${col} AS p FROM ${table} WHERE id = ?`).get(id) as { p: string } | undefined)?.p ?? null;
  push('program', db.prepare('SELECT id, title, deleted_at FROM programs WHERE deleted_at IS NOT NULL').all() as never, null, () => null);
  push('semester', db.prepare('SELECT id, title, deleted_at FROM semesters WHERE deleted_at IS NOT NULL').all() as never, 'program', parentLookup('semesters', 'program_id'));
  push('course', db.prepare('SELECT id, title, deleted_at FROM courses WHERE deleted_at IS NOT NULL').all() as never, 'semester', parentLookup('courses', 'semester_id'));
  push('section', db.prepare('SELECT id, title, deleted_at FROM sections WHERE deleted_at IS NOT NULL').all() as never, 'course', parentLookup('sections', 'course_id'));
  // Deleted notes, each listed once through its first card (the trash UI works with card ids).
  const deletedNotes = db.prepare('SELECT * FROM notes WHERE deleted_at IS NOT NULL').all() as NoteRow[];
  push(
    'card',
    deletedNotes.flatMap((n) => {
      const rep = db.prepare('SELECT id FROM cards WHERE note_id = ? ORDER BY retired_at IS NOT NULL, variant_order LIMIT 1').get(n.id) as { id: string } | undefined;
      return rep ? [{ id: rep.id, title: noteDisplayTitle(ctx, n), deleted_at: n.deleted_at! }] : [];
    }),
    'section',
    parentLookup('cards', 'section_id'),
  );
  return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

// ---------- Duplication ----------

export function duplicateCourse(
  ctx: Ctx,
  courseId: string,
  input: { semesterId: string; copyProgress?: boolean; title?: string },
) {
  const src = getRow<CourseRow>(ctx, 'course', courseId);
  assertNotInTrash(ctx, 'course', courseId, 'duplicating');
  const semesterId = parse(zId, input.semesterId);
  getRow(ctx, 'semester', semesterId);
  assertParentUsable(ctx, 'semester', semesterId);
  const db = ctx.db;
  const ts = nowIso(ctx);
  const t = ctx.now().getTime();
  let newCourseId = '';
  db.transaction(() => {
    newCourseId = newId(t);
    const title = input.title?.trim() || (semesterId === src.semester_id ? `${src.title} (copy)` : src.title);
    db.prepare(
      `INSERT INTO courses (id, semester_id, title, module_code, color, icon, description, exam_date, position, is_demo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(newCourseId, semesterId, title, src.module_code, src.color, src.icon, src.description, nextPosition(ctx, 'course', semesterId), src.is_demo, ts, ts);
    const sections = db
      .prepare('SELECT * FROM sections WHERE course_id = ? AND deleted_at IS NULL ORDER BY position')
      .all(courseId) as SectionRow[];
    for (const s of sections) {
      const sid = newId(t);
      db.prepare(
        `INSERT INTO sections (id, course_id, title, kind, week_number, date, notes, position, is_demo, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      ).run(sid, newCourseId, s.title, s.kind, s.week_number, s.notes, s.position, s.is_demo, s.archived_at, ts, ts);
      const notes = db.prepare('SELECT * FROM notes WHERE section_id = ? AND deleted_at IS NULL ORDER BY position').all(s.id) as NoteRow[];
      for (const n of notes) {
        const nid = newId(t);
        db.prepare(
          `INSERT INTO notes (id, section_id, kind, template_id, fields_json, options_json, position, is_demo, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(nid, sid, n.kind, n.template_id, n.fields_json, n.options_json, n.position, n.is_demo, ts, ts);
        const cards = db.prepare('SELECT * FROM cards WHERE note_id = ? AND retired_at IS NULL ORDER BY variant_order').all(n.id) as CardRow[];
        for (const c of cards) {
          const cid = newId(t);
          db.prepare(
            `INSERT INTO cards (id, note_id, section_id, variant, variant_order, variant_label, render_json, front, back, explanation, hint, source,
               bookmarked, suspended_at, position, revision, is_demo, created_at, updated_at)
             SELECT ?, ?, ?, variant, variant_order, variant_label, render_json, front, back, explanation, hint, source,
               bookmarked, suspended_at, position, 1, is_demo, ?, ? FROM cards WHERE id = ?`,
          ).run(cid, nid, sid, ts, ts, c.id);
          db.prepare('INSERT INTO card_tags (card_id, tag_id) SELECT ?, tag_id FROM card_tags WHERE card_id = ?').run(cid, c.id);
          if (input.copyProgress) {
            db.prepare(
              `INSERT INTO card_schedules (card_id, due_date, interval_days, review_count, lapse_count, first_reviewed_at, last_reviewed_at, last_rating, scheduler_version, updated_at)
               SELECT ?, due_date, interval_days, review_count, lapse_count, first_reviewed_at, last_reviewed_at, last_rating, scheduler_version, ? FROM card_schedules WHERE card_id = ?`,
            ).run(cid, ts, c.id);
          }
        }
      }
    }
  })();
  return getItem(ctx, 'course', newCourseId);
}

// ---------- Current semester ----------

export function resolveCurrentSemester(ctx: Ctx): (SemesterRow & { program_title: string }) | null {
  const settings = getSettings(ctx);
  const visible = `se.deleted_at IS NULL AND se.archived_at IS NULL AND p.deleted_at IS NULL AND p.archived_at IS NULL`;
  const base = `SELECT se.*, p.title AS program_title FROM semesters se JOIN programs p ON p.id = se.program_id WHERE ${visible}`;
  if (settings.currentSemesterId) {
    const row = ctx.db.prepare(`${base} AND se.id = ?`).get(settings.currentSemesterId);
    if (row) return row as SemesterRow & { program_title: string };
  }
  const d = today(ctx);
  // The user's own semesters win over demo content; then a semester whose dates include today; then the newest.
  for (const demo of [0, 1]) {
    const dated = ctx.db
      .prepare(`${base} AND se.is_demo = ? AND se.start_date IS NOT NULL AND se.start_date <= ? AND (se.end_date IS NULL OR se.end_date >= ?) ORDER BY se.start_date DESC LIMIT 1`)
      .get(demo, d, d);
    if (dated) return dated as SemesterRow & { program_title: string };
    const latest = ctx.db.prepare(`${base} AND se.is_demo = ? ORDER BY se.created_at DESC LIMIT 1`).get(demo);
    if (latest) return latest as SemesterRow & { program_title: string };
  }
  return null;
}

export function assertExists(ctx: Ctx, level: Level, id: string) {
  getRow(ctx, level, id);
}

export function ensureLevel(level: string): Level {
  if (!isLevel(level)) throw new AppError(404, 'not_found', 'Unknown item type');
  return level;
}
