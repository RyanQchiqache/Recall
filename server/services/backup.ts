import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { COURSE_COLORS, COURSE_ICONS, SECTION_KINDS } from '../../shared/catalog.ts';
import { isLocalDate } from '../../shared/dates.ts';
import type { BackupStatus, RestorePreview, SnapshotInfo } from '../../shared/types.ts';
import { APP_VERSION } from '../config.ts';
import { nowIso, type Ctx } from '../context.ts';
import { snapshotFileName, type DB } from '../db/connection.ts';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../db/migrations.ts';
import { AppError, badRequest, newId, parseJson, placeholders } from '../lib/util.ts';
import { assertParentUsable, getRow } from './hierarchy.ts';
import { detectImageType, MAX_MEDIA_BYTES, MEDIA_FILENAME_RE, referencedMedia } from './media.ts';
import { getMeta, getSettings, setMeta } from './settings.ts';

export const BACKUP_FORMAT = 'recall-backup';
export const BACKUP_FORMAT_VERSION = 1;

/** Tables in foreign-key insertion order. */
export const FULL_TABLES = [
  'programs',
  'semesters',
  'courses',
  'sections',
  'cards',
  'tags',
  'card_tags',
  'media_assets',
  'card_schedules',
  'study_sessions',
  'session_cards',
  'review_events',
  'settings',
  'drafts',
] as const;
type TableName = (typeof FULL_TABLES)[number];

type Row = Record<string, string | number | null>;
export interface BackupData {
  tables: Partial<Record<TableName, Row[]>>;
}

export interface Manifest {
  format: string;
  formatVersion: number;
  kind: 'full' | 'course';
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  counts: Record<string, number>;
  includes: string[];
  excludes: string[];
  media: { filename: string; sha256: string; size: number }[];
}

// Limits for defensive extraction.
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 2 * 1024 * 1024 * 1024;
const MAX_DATA_JSON = 512 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
const MAX_RATIO = 2000;

// ---------- Export ----------

function readTables(db: DB, tables: readonly TableName[], filter?: Partial<Record<TableName, { sql: string; params: unknown[] }>>): BackupData {
  const out: BackupData = { tables: {} };
  for (const t of tables) {
    const f = filter?.[t];
    out.tables[t] = (f ? db.prepare(f.sql).all(...f.params) : db.prepare(`SELECT * FROM ${t}`).all()) as Row[];
  }
  // Local status entries are machine-specific and never exported.
  if (out.tables.settings) out.tables.settings = out.tables.settings.filter((r) => !String(r.key).startsWith('meta:'));
  return out;
}

function mediaFiles(ctx: Ctx, filenames: string[]): { zip: Zippable; list: Manifest['media']; missing: string[] } {
  const zip: Zippable = {};
  const list: Manifest['media'] = [];
  const missing: string[] = [];
  for (const name of filenames) {
    if (!MEDIA_FILENAME_RE.test(name)) continue;
    const p = path.join(ctx.config.mediaDir, name);
    if (!fs.existsSync(p)) {
      missing.push(name);
      continue;
    }
    const buf = fs.readFileSync(p);
    zip[`media/${name}`] = [buf, { level: 0 }];
    list.push({ filename: name, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length });
  }
  return { zip, list, missing };
}

function buildZip(manifest: Manifest, data: BackupData, media: Zippable): Buffer {
  const files: Zippable = {
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    'data.json': new TextEncoder().encode(JSON.stringify(data)),
    ...media,
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}

function countsOf(data: BackupData): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(data.tables)) counts[k] = v?.length ?? 0;
  return counts;
}

export function exportFull(ctx: Ctx): { filename: string; buffer: Buffer } {
  const data = ctx.db.transaction(() => readTables(ctx.db, FULL_TABLES))();
  const mediaNames = (data.tables.media_assets ?? []).map((m) => String(m.filename));
  const media = mediaFiles(ctx, mediaNames);
  const manifest: Manifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    kind: 'full',
    schemaVersion: LATEST_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    createdAt: nowIso(ctx),
    counts: countsOf(data),
    includes: [
      'Study programs, semesters, courses and sections (including archived items and trash)',
      'Cards, tags and uploaded images',
      'Card schedules (due dates, intervals, lapse counts)',
      'Complete review history and study sessions (including an open session)',
      'Settings and unsaved card drafts',
    ],
    excludes: ['Automatic snapshot files and local backup status'],
    media: media.list,
  };
  const stamp = manifest.createdAt.replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return { filename: `recall-backup-${stamp}.zip`, buffer: buildZip(manifest, data, media.zip) };
}

export function exportCourse(ctx: Ctx, courseId: string): { filename: string; buffer: Buffer } {
  const course = getRow<{ title: string }>(ctx, 'course', courseId);
  const cardsIn = `SELECT id FROM cards WHERE deleted_at IS NULL AND section_id IN (SELECT id FROM sections WHERE course_id = ? AND deleted_at IS NULL)`;
  const data = ctx.db.transaction(() =>
    readTables(ctx.db, ['courses', 'sections', 'cards', 'tags', 'card_tags', 'card_schedules', 'media_assets'], {
      courses: { sql: 'SELECT * FROM courses WHERE id = ?', params: [courseId] },
      sections: { sql: 'SELECT * FROM sections WHERE course_id = ? AND deleted_at IS NULL', params: [courseId] },
      cards: { sql: `SELECT * FROM cards WHERE id IN (${cardsIn})`, params: [courseId] },
      card_tags: { sql: `SELECT * FROM card_tags WHERE card_id IN (${cardsIn})`, params: [courseId] },
      tags: { sql: `SELECT * FROM tags WHERE id IN (SELECT tag_id FROM card_tags WHERE card_id IN (${cardsIn}))`, params: [courseId] },
      card_schedules: { sql: `SELECT * FROM card_schedules WHERE card_id IN (${cardsIn})`, params: [courseId] },
      media_assets: { sql: 'SELECT * FROM media_assets WHERE 0', params: [] },
    }),
  )();
  const referenced = new Set<string>();
  for (const c of data.tables.cards ?? []) {
    for (const f of ['front', 'back', 'explanation', 'hint'] as const) for (const m of referencedMedia(String(c[f] ?? ''))) referenced.add(m);
  }
  const names = [...referenced];
  data.tables.media_assets = names.length
    ? (ctx.db.prepare(`SELECT * FROM media_assets WHERE filename IN (${placeholders(names.length)})`).all(...names) as Row[])
    : [];
  const media = mediaFiles(ctx, names);
  const manifest: Manifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    kind: 'course',
    schemaVersion: LATEST_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    createdAt: nowIso(ctx),
    counts: countsOf(data),
    includes: [
      `Course “${course.title}” with its sections (archived sections included, trash excluded)`,
      'Cards, tags and the images they reference',
      'Card schedules (due dates, intervals, lapse counts) — optional on import',
    ],
    excludes: ['Review history and study sessions', 'App settings', 'Other courses, semesters and programs'],
    media: media.list,
  };
  const safe = course.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'course';
  return { filename: `recall-course-${safe}.zip`, buffer: buildZip(manifest, data, media.zip) };
}

// ---------- Archive reading ----------

interface ParsedArchive {
  manifest: Manifest;
  data: BackupData;
  media: Map<string, Uint8Array>;
}

export function readArchive(buf: Buffer): ParsedArchive {
  if (buf.length > MAX_ARCHIVE_BYTES) throw badRequest('The backup file is too large (over 1 GB)');
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw badRequest('This is not a ZIP backup file');
  const problems: string[] = [];
  let entries = 0;
  let declaredTotal = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf), {
      filter: (f) => {
        entries++;
        if (entries > MAX_ENTRIES) {
          problems.push('The archive contains too many files');
          return false;
        }
        if (f.name.endsWith('/')) return false; // directory entries
        const allowed = f.name === 'manifest.json' || f.name === 'data.json' || /^media\/[^/\\]+$/.test(f.name);
        if (!allowed || f.name.includes('..') || f.name.includes('\\') || f.name.startsWith('/')) {
          problems.push(`Unexpected file in archive: ${f.name.slice(0, 120)}`);
          return false;
        }
        if (f.name.startsWith('media/') && !MEDIA_FILENAME_RE.test(f.name.slice(6))) {
          problems.push(`Unsafe media filename: ${f.name.slice(0, 120)}`);
          return false;
        }
        const limit = f.name === 'data.json' ? MAX_DATA_JSON : f.name === 'manifest.json' ? 1024 * 1024 : MAX_MEDIA_BYTES;
        if (f.originalSize > limit) {
          problems.push(`${f.name} is larger than allowed`);
          return false;
        }
        if (f.size > 0 && f.originalSize / f.size > MAX_RATIO) {
          problems.push(`${f.name} has a suspicious compression ratio`);
          return false;
        }
        declaredTotal += f.originalSize;
        if (declaredTotal > MAX_TOTAL_UNCOMPRESSED) {
          problems.push('The archive expands to more than 2 GB');
          return false;
        }
        return true;
      },
    });
  } catch (e) {
    throw badRequest(`The archive could not be read: ${(e as Error).message}`);
  }
  if (problems.length) throw badRequest('The backup archive was rejected', { problems: problems.slice(0, 20) });
  let actualTotal = 0;
  for (const [name, content] of Object.entries(files)) {
    actualTotal += content.length;
    const limit = name === 'data.json' ? MAX_DATA_JSON : name === 'manifest.json' ? 1024 * 1024 : MAX_MEDIA_BYTES;
    if (content.length > limit || actualTotal > MAX_TOTAL_UNCOMPRESSED) throw badRequest(`${name} is larger than allowed`);
  }
  if (!files['manifest.json'] || !files['data.json']) throw badRequest('The archive is missing manifest.json or data.json');
  const dec = new TextDecoder('utf-8', { fatal: true });
  let manifest: Manifest;
  let data: BackupData;
  try {
    manifest = JSON.parse(dec.decode(files['manifest.json']));
    data = JSON.parse(dec.decode(files['data.json']));
  } catch {
    throw badRequest('The backup contains invalid JSON');
  }
  if (!manifest || manifest.format !== BACKUP_FORMAT) throw badRequest('This file is not a Recall backup');
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    throw badRequest(`This backup uses format version ${manifest.formatVersion}, which is newer than this app supports. Update Recall first.`);
  }
  if (typeof manifest.schemaVersion !== 'number' || manifest.schemaVersion > LATEST_SCHEMA_VERSION || manifest.schemaVersion < 1) {
    throw badRequest(`This backup uses database schema ${manifest.schemaVersion}, which this app does not support. Update Recall first.`);
  }
  if (manifest.kind !== 'full' && manifest.kind !== 'course') throw badRequest('Unknown backup kind');
  if (!data || typeof data !== 'object' || !data.tables || typeof data.tables !== 'object') throw badRequest('Backup data is malformed');
  const media = new Map<string, Uint8Array>();
  for (const [name, content] of Object.entries(files)) {
    if (!name.startsWith('media/')) continue;
    const filename = name.slice(6);
    const type = detectImageType(content);
    if (!type || !filename.endsWith(`.${type.ext}`)) throw badRequest(`Media file ${filename} is not the image type its name says`);
    media.set(filename, content);
  }
  return { manifest, data, media };
}

// ---------- Validation via scratch database ----------

function tableColumns(db: DB, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

function validateRows(db: DB, data: BackupData, tables: readonly TableName[]) {
  for (const t of Object.keys(data.tables)) {
    if (!(tables as readonly string[]).includes(t)) throw badRequest(`Unexpected table in backup: ${t.slice(0, 60)}`);
  }
  for (const t of tables) {
    const rows = data.tables[t];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) throw badRequest(`Table ${t} is malformed`);
    const cols = tableColumns(db, t);
    for (const [i, r] of rows.entries()) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw badRequest(`Row ${i + 1} of ${t} is malformed`);
      for (const [k, v] of Object.entries(r)) {
        if (!cols.has(k)) throw badRequest(`Unknown column ${t}.${k.slice(0, 60)}`);
        if (v !== null && typeof v !== 'string' && typeof v !== 'number') throw badRequest(`Invalid value in ${t}.${k}`);
      }
    }
  }
}

function insertRows(db: DB, data: BackupData, tables: readonly TableName[]) {
  for (const t of tables) {
    const rows = data.tables[t] ?? [];
    const stmts = new Map<string, Database.Statement>();
    for (const r of rows) {
      const keys = Object.keys(r);
      const sig = keys.join(',');
      let stmt = stmts.get(sig);
      if (!stmt) {
        stmt = db.prepare(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${placeholders(keys.length)})`);
        stmts.set(sig, stmt);
      }
      stmt.run(...keys.map((k) => r[k]));
    }
  }
}

function createScratch(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const m of MIGRATIONS) db.exec(m.sql);
  return db;
}

/** Validate a full backup by loading it into an empty scratch database. Throws on any problem. */
function validateFull(data: BackupData, media: Map<string, Uint8Array>, localMediaDir: string): string[] {
  const warnings: string[] = [];
  const scratch = createScratch();
  try {
    validateRows(scratch, data, FULL_TABLES);
    try {
      scratch.transaction(() => insertRows(scratch, data, FULL_TABLES))();
    } catch (e) {
      throw badRequest(`The backup is inconsistent: ${(e as Error).message}`);
    }
    const fk = scratch.prepare('PRAGMA foreign_key_check').all();
    if (fk.length) throw badRequest('The backup has broken references between records');
    const open = (scratch.prepare("SELECT COUNT(*) AS n FROM study_sessions WHERE is_open = 1").get() as { n: number }).n;
    if (open > 1) throw badRequest('The backup contains more than one open session');
  } finally {
    scratch.close();
  }
  for (const m of data.tables.media_assets ?? []) {
    const name = String(m.filename);
    if (!MEDIA_FILENAME_RE.test(name)) throw badRequest(`Unsafe media filename in backup: ${name.slice(0, 80)}`);
    if (!media.has(name) && !fs.existsSync(path.join(localMediaDir, name))) warnings.push(`Image ${name} is listed but missing from the archive`);
  }
  const known = new Set((data.tables.media_assets ?? []).map((m) => String(m.filename)));
  let missingRefs = 0;
  for (const c of data.tables.cards ?? []) {
    for (const f of ['front', 'back', 'explanation', 'hint'] as const) {
      for (const ref of referencedMedia(String(c[f] ?? ''))) if (!known.has(ref) && !media.has(ref)) missingRefs++;
    }
  }
  if (missingRefs) warnings.push(`${missingRefs} image reference(s) in cards point to images that are not in the backup`);
  return warnings;
}

// ---------- Restore flow ----------

const TOKEN_RE = /^[a-f0-9]{32}$/;

function stagingPath(ctx: Ctx, token: string, ext: string) {
  return path.join(ctx.config.tmpDir, `restore-${token}.${ext}`);
}

/** Read a SQLite snapshot (made with the backup API) into the backup data format. */
function readSnapshotData(file: string): { data: BackupData; schemaVersion: number } {
  let db: DB;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    throw badRequest('The snapshot file could not be opened');
  }
  try {
    const v = (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
    if (v > LATEST_SCHEMA_VERSION) throw badRequest('This snapshot was made by a newer version of Recall');
    return { data: readTables(db, FULL_TABLES), schemaVersion: v };
  } finally {
    db.close();
  }
}

function previewFrom(token: string, manifest: Manifest, warnings: string[]): RestorePreview {
  return {
    token,
    kind: manifest.kind,
    formatVersion: manifest.formatVersion,
    schemaVersion: manifest.schemaVersion,
    appVersion: manifest.appVersion,
    createdAt: manifest.createdAt,
    counts: manifest.counts,
    warnings,
    includes: manifest.includes ?? [],
  };
}

export function previewArchive(ctx: Ctx, buf: Buffer): RestorePreview {
  const parsed = readArchive(buf);
  const counts = countsOf(parsed.data);
  let warnings: string[];
  if (parsed.manifest.kind === 'full') {
    warnings = validateFull(parsed.data, parsed.media, ctx.config.mediaDir);
  } else {
    warnings = validateCoursePackage(parsed.data, parsed.media);
  }
  const token = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(ctx.config.tmpDir, { recursive: true });
  fs.writeFileSync(stagingPath(ctx, token, 'zip'), buf);
  return previewFrom(token, { ...parsed.manifest, counts }, warnings);
}

export function previewSnapshot(ctx: Ctx, name: string): RestorePreview {
  const file = snapshotPath(ctx, name);
  const { data, schemaVersion } = readSnapshotData(file);
  const warnings = validateFull(data, new Map(), ctx.config.mediaDir);
  const token = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(ctx.config.tmpDir, { recursive: true });
  fs.writeFileSync(stagingPath(ctx, token, 'snapshot'), name);
  const stat = fs.statSync(file);
  return {
    token,
    kind: 'full',
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion,
    appVersion: APP_VERSION,
    createdAt: stat.mtime.toISOString(),
    counts: countsOf(data),
    warnings: [...warnings, 'Images are not stored inside snapshots; existing images in the media folder are kept.'],
    includes: ['Everything in the database at the time of the snapshot'],
  };
}

export async function applyFullRestore(ctx: Ctx, token: string): Promise<{ preRestoreSnapshot: string }> {
  if (!TOKEN_RE.test(token)) throw badRequest('Invalid restore token');
  const zipPath = stagingPath(ctx, token, 'zip');
  const snapRef = stagingPath(ctx, token, 'snapshot');
  let data: BackupData;
  let media = new Map<string, Uint8Array>();
  if (fs.existsSync(zipPath)) {
    const parsed = readArchive(fs.readFileSync(zipPath));
    if (parsed.manifest.kind !== 'full') throw badRequest('This is a course package. Import it into a semester instead.');
    data = parsed.data;
    media = parsed.media;
  } else if (fs.existsSync(snapRef)) {
    data = readSnapshotData(snapshotPath(ctx, fs.readFileSync(snapRef, 'utf8'))).data;
  } else {
    throw badRequest('This restore preview has expired. Choose the backup file again.');
  }
  validateFull(data, media, ctx.config.mediaDir);

  // Safety net first: consistent snapshot of the current database.
  const pre = await createSnapshot(ctx, 'pre-restore');

  // Stage media, then swap the database contents in one transaction.
  const stageDir = path.join(ctx.config.tmpDir, `media-${token}`);
  fs.mkdirSync(stageDir, { recursive: true });
  try {
    for (const [name, content] of media) fs.writeFileSync(path.join(stageDir, name), content);
    const localMeta = ctx.db.prepare("SELECT * FROM settings WHERE key LIKE 'meta:%'").all() as Row[];
    const db = ctx.db;
    db.transaction(() => {
      for (const t of [...FULL_TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
      insertRows(db, data, FULL_TABLES);
      insertRows(db, { tables: { settings: localMeta.filter((m) => !(data.tables.settings ?? []).some((s) => s.key === m.key)) } }, ['settings']);
      db.prepare("INSERT INTO cards_fts(cards_fts) VALUES('rebuild')").run();
      const fk = db.prepare('PRAGMA foreign_key_check').all();
      if (fk.length) throw new AppError(400, 'bad_request', 'Restore produced broken references; nothing was changed');
    })();
    fs.mkdirSync(ctx.config.mediaDir, { recursive: true });
    for (const name of media.keys()) {
      const target = path.join(ctx.config.mediaDir, name);
      if (!fs.existsSync(target)) fs.renameSync(path.join(stageDir, name), target);
    }
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(snapRef, { force: true });
  }
  return { preRestoreSnapshot: pre.name };
}

// ---------- Course packages ----------

function validateCoursePackage(data: BackupData, media: Map<string, Uint8Array>): string[] {
  const allowed = ['courses', 'sections', 'cards', 'tags', 'card_tags', 'card_schedules', 'media_assets'] as const;
  const scratch = createScratch();
  try {
    validateRows(scratch, data, allowed as unknown as readonly TableName[]);
  } finally {
    scratch.close();
  }
  if ((data.tables.courses ?? []).length !== 1) throw badRequest('A course package must contain exactly one course');
  const warnings: string[] = [];
  const sectionIds = new Set((data.tables.sections ?? []).map((s) => String(s.id)));
  for (const c of data.tables.cards ?? []) {
    if (!sectionIds.has(String(c.section_id))) throw badRequest('A card in the package refers to a missing section');
    if (typeof c.front !== 'string' || typeof c.back !== 'string') throw badRequest('A card in the package is missing its front or back');
  }
  for (const m of data.tables.media_assets ?? []) if (!media.has(String(m.filename))) warnings.push(`Image ${m.filename} is missing from the package`);
  return warnings;
}

/** Package values are untrusted: anything outside the app's own vocabulary falls back to a default. */
const oneOf = <T extends string>(allowed: readonly T[], v: unknown, def: T): T => (allowed.includes(v as T) ? (v as T) : def);
const dateOrNull = (v: unknown) => (isLocalDate(v) ? v : null);
const SECTION_KIND_VALUES = SECTION_KINDS.map((k) => k.value);

function validSchedule(s: Row): boolean {
  const int = (v: unknown, min: number) => Number.isInteger(v) && (v as number) >= min;
  return (
    isLocalDate(s.due_date) &&
    int(s.interval_days, 1) &&
    int(s.review_count, 0) &&
    int(s.lapse_count, 0) &&
    int(s.last_rating, 1) &&
    (s.last_rating as number) <= 4 &&
    typeof s.first_reviewed_at === 'string' &&
    !Number.isNaN(Date.parse(s.first_reviewed_at)) &&
    typeof s.last_reviewed_at === 'string' &&
    !Number.isNaN(Date.parse(s.last_reviewed_at)) &&
    typeof s.scheduler_version === 'string'
  );
}

export function importCoursePackage(ctx: Ctx, token: string, opts: { semesterId: string; includeSchedules: boolean }): { courseId: string } {
  if (!TOKEN_RE.test(token)) throw badRequest('Invalid import token');
  const zipPath = stagingPath(ctx, token, 'zip');
  if (!fs.existsSync(zipPath)) throw badRequest('This import preview has expired. Choose the file again.');
  const { manifest, data, media } = readArchive(fs.readFileSync(zipPath));
  if (manifest.kind !== 'course') throw badRequest('This is a full backup. Use “Restore full backup” instead.');
  validateCoursePackage(data, media);
  getRow(ctx, 'semester', opts.semesterId);
  assertParentUsable(ctx, 'semester', opts.semesterId);
  const db = ctx.db;
  const t = ctx.now().getTime();
  const ts = nowIso(ctx);
  const course = data.tables.courses![0];
  const courseId = newId(t);
  const sectionMap = new Map<string, string>();
  const cardMap = new Map<string, string>();
  db.transaction(() => {
    const pos = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM courses WHERE semester_id = ?').get(opts.semesterId) as { p: number }).p;
    db.prepare(
      `INSERT INTO courses (id, semester_id, title, module_code, color, icon, description, exam_date, exam_set_at, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(courseId, opts.semesterId, String(course.title ?? 'Imported course'), String(course.module_code ?? ''), oneOf(COURSE_COLORS, course.color, 'indigo'), oneOf(COURSE_ICONS, course.icon, 'book-open'), String(course.description ?? ''), dateOrNull(course.exam_date), dateOrNull(course.exam_date) ? ts : null, pos, ts, ts);
    for (const s of data.tables.sections ?? []) {
      const id = newId(t);
      sectionMap.set(String(s.id), id);
      db.prepare(
        `INSERT INTO sections (id, course_id, title, kind, week_number, date, notes, position, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, courseId, String(s.title ?? 'Section'), oneOf(SECTION_KIND_VALUES, s.kind, 'lecture'), s.week_number ?? null, dateOrNull(s.date), String(s.notes ?? ''), Number(s.position ?? 0), s.archived_at ?? null, ts, ts);
    }
    for (const c of data.tables.cards ?? []) {
      const id = newId(t);
      cardMap.set(String(c.id), id);
      db.prepare(
        `INSERT INTO cards (id, section_id, front, back, explanation, hint, source, bookmarked, suspended_at, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, sectionMap.get(String(c.section_id)), String(c.front), String(c.back), String(c.explanation ?? ''), String(c.hint ?? ''), String(c.source ?? ''), Number(c.bookmarked ?? 0) ? 1 : 0, c.suspended_at ?? null, Number(c.position ?? 0), ts, ts);
    }
    const tagName = new Map((data.tables.tags ?? []).map((tg) => [String(tg.id), String(tg.name)]));
    for (const ct of data.tables.card_tags ?? []) {
      const cardId = cardMap.get(String(ct.card_id));
      const name = tagName.get(String(ct.tag_id));
      if (!cardId || !name) continue;
      let tag = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(name) as { id: string } | undefined;
      if (!tag) {
        tag = { id: newId(t) };
        db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)').run(tag.id, name, ts);
      }
      db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)').run(cardId, tag.id);
    }
    if (opts.includeSchedules) {
      for (const s of data.tables.card_schedules ?? []) {
        const cardId = cardMap.get(String(s.card_id));
        if (!cardId || !validSchedule(s)) continue; // an invalid schedule leaves the card new
        db.prepare(
          `INSERT INTO card_schedules (card_id, due_date, interval_days, review_count, lapse_count, first_reviewed_at, last_reviewed_at, last_rating, scheduler_version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(cardId, s.due_date, s.interval_days, s.review_count, s.lapse_count, s.first_reviewed_at, s.last_reviewed_at, s.last_rating, s.scheduler_version, ts);
      }
    }
    for (const m of data.tables.media_assets ?? []) {
      const name = String(m.filename);
      const content = media.get(name);
      if (!content) continue;
      const exists = db.prepare('SELECT 1 FROM media_assets WHERE filename = ?').get(name);
      if (!exists) {
        db.prepare('INSERT INTO media_assets (id, filename, original_name, mime_type, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          newId(t), name, String(m.original_name ?? ''), String(m.mime_type), content.length, crypto.createHash('sha256').update(content).digest('hex'), ts,
        );
      }
    }
  })();
  fs.mkdirSync(ctx.config.mediaDir, { recursive: true });
  for (const [name, content] of media) {
    const target = path.join(ctx.config.mediaDir, name);
    if (!fs.existsSync(target)) fs.writeFileSync(target, content);
  }
  fs.rmSync(zipPath, { force: true });
  return { courseId };
}

// ---------- Snapshots (SQLite online backup API) ----------

const SNAPSHOT_RE = /^(auto|manual|pre-restore|pre-migration-v\d+)-\d{8}-\d{6}\.sqlite$/;

export function backupDir(ctx: Ctx): string {
  return getSettings(ctx).backup.directory ?? ctx.config.defaultBackupDir;
}

function snapshotPath(ctx: Ctx, name: string): string {
  if (!SNAPSHOT_RE.test(name)) throw badRequest('Invalid snapshot name');
  const p = path.join(backupDir(ctx), name);
  if (!fs.existsSync(p)) throw new AppError(404, 'not_found', 'Snapshot not found');
  return p;
}

export function listSnapshots(ctx: Ctx): SnapshotInfo[] {
  const dirs = new Set([backupDir(ctx), ctx.config.defaultBackupDir]);
  const out: SnapshotInfo[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!SNAPSHOT_RE.test(name) || seen.has(name)) continue;
      if (dir !== backupDir(ctx)) continue;
      seen.add(name);
      const st = fs.statSync(path.join(dir, name));
      const prefix = name.split('-')[0];
      const kind: SnapshotInfo['kind'] =
        prefix === 'auto' ? 'auto' : prefix === 'manual' ? 'manual' : name.startsWith('pre-restore') ? 'pre-restore' : name.startsWith('pre-migration') ? 'pre-migration' : 'other';
      out.push({ name, sizeBytes: st.size, createdAt: st.mtime.toISOString(), kind });
    }
  }
  return out.sort((a, b) => b.name.slice(-22).localeCompare(a.name.slice(-22)));
}

export async function createSnapshot(ctx: Ctx, kind: 'auto' | 'manual' | 'pre-restore'): Promise<{ name: string; path: string }> {
  const dir = backupDir(ctx);
  fs.mkdirSync(dir, { recursive: true });
  let name = snapshotFileName(kind, ctx.now());
  let i = 0;
  while (fs.existsSync(path.join(dir, name)) && i < 100) {
    // Same-second collision: bump the timestamp by a second.
    name = snapshotFileName(kind, new Date(ctx.now().getTime() + ++i * 1000));
  }
  const target = path.join(dir, name);
  await ctx.db.backup(`${target}.part`);
  fs.renameSync(`${target}.part`, target);
  return { name, path: target };
}

function pruneAuto(ctx: Ctx) {
  const keep = getSettings(ctx).backup.retention;
  const autos = listSnapshots(ctx).filter((s) => s.kind === 'auto');
  for (const s of autos.slice(keep)) fs.rmSync(path.join(backupDir(ctx), s.name), { force: true });
}

export function backupStatus(ctx: Ctx): BackupStatus {
  return getMeta<BackupStatus>(ctx, 'backup_status', { lastSuccessAt: null, lastFile: null, lastErrorAt: null, lastError: null });
}

export async function runAutoBackup(ctx: Ctx, opts: { force?: boolean } = {}): Promise<BackupStatus> {
  const settings = getSettings(ctx);
  const status = backupStatus(ctx);
  if (!opts.force) {
    if (!settings.backup.enabled) return status;
    const last = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : 0;
    if (ctx.now().getTime() - last < settings.backup.intervalHours * 3600_000) return status;
  }
  try {
    const snap = await createSnapshot(ctx, opts.force ? 'manual' : 'auto');
    pruneAuto(ctx);
    const next: BackupStatus = { ...status, lastSuccessAt: nowIso(ctx), lastFile: snap.path };
    setMeta(ctx, 'backup_status', next);
    return next;
  } catch (e) {
    const next: BackupStatus = { ...status, lastErrorAt: nowIso(ctx), lastError: (e as Error).message };
    setMeta(ctx, 'backup_status', next);
    if (opts.force) throw new AppError(500, 'backup_failed', `Snapshot failed: ${(e as Error).message}`);
    return next;
  }
}

/** Remove stale restore staging files (older than a day). */
export function cleanupTmp(ctx: Ctx) {
  const dir = ctx.config.tmpDir;
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - 24 * 3600_000;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function parseManifestJson(text: string): Manifest | null {
  return parseJson<Manifest | null>(text, null);
}
