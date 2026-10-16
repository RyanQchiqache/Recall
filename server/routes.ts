import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Level, TrashType } from '../shared/types.ts';
import { APP_VERSION } from './config.ts';
import type { Ctx } from './context.ts';
import { currentSchemaVersion } from './db/connection.ts';
import { AppError, badRequest } from './lib/util.ts';
import { parse, zId } from './lib/validate.ts';
import * as backup from './services/backup.ts';
import * as cards from './services/cards.ts';
import * as csv from './services/csv.ts';
import * as demo from './services/demo.ts';
import * as drafts from './services/drafts.ts';
import * as h from './services/hierarchy.ts';
import { MAX_MEDIA_BYTES, saveMedia } from './services/media.ts';
import * as sessions from './services/sessions.ts';
import { getSettings, updateSettings } from './services/settings.ts';
import { getDashboard, getStats } from './services/stats.ts';

type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string | undefined>; Body: unknown }>;

const TRASH_TYPES = new Set(['program', 'semester', 'course', 'section', 'card']);
function trashType(v: string): TrashType {
  if (!TRASH_TYPES.has(v)) throw new AppError(404, 'not_found', 'Unknown item type');
  return v as TrashType;
}

async function readUpload(req: FastifyRequest, maxBytes: number): Promise<{ buffer: Buffer; filename: string }> {
  if (!req.isMultipart()) throw badRequest('Expected a file upload');
  const file = await req.file({ limits: { fileSize: maxBytes, files: 1 } });
  if (!file) throw badRequest('No file was uploaded');
  const buffer = await file.toBuffer();
  if (file.file.truncated) throw new AppError(413, 'file_too_large', 'The file is too large');
  return { buffer, filename: file.filename };
}

function download(reply: FastifyReply, filename: string, type: string, body: Buffer | string) {
  reply.header('Content-Type', type);
  reply.header('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\-]+/g, '_')}"`);
  reply.header('Cache-Control', 'no-store');
  return reply.send(body);
}

export function registerRoutes(app: FastifyInstance, ctx: Ctx) {
  const get = (url: string, fn: (req: Req, reply: FastifyReply) => unknown) => app.get(url, (req, reply) => fn(req as Req, reply));
  const post = (url: string, fn: (req: Req, reply: FastifyReply) => unknown) => app.post(url, (req, reply) => fn(req as Req, reply));
  const patch = (url: string, fn: (req: Req, reply: FastifyReply) => unknown) => app.patch(url, (req, reply) => fn(req as Req, reply));
  const put = (url: string, fn: (req: Req, reply: FastifyReply) => unknown) => app.put(url, (req, reply) => fn(req as Req, reply));
  const del = (url: string, fn: (req: Req, reply: FastifyReply) => unknown) => app.delete(url, (req, reply) => fn(req as Req, reply));
  const body = (req: Req) => (req.body ?? {}) as Record<string, unknown>;

  // ----- System & settings -----
  // GET /api/health and the startup/shutdown endpoints are registered in startup.ts.
  get('/api/system', () => ({
    appVersion: APP_VERSION,
    schemaVersion: currentSchemaVersion(ctx.db),
    dataDir: ctx.config.dataDir,
    dbPath: ctx.config.dbPath,
    mediaDir: ctx.config.mediaDir,
    backupDir: backup.backupDir(ctx),
    host: ctx.config.host,
    port: ctx.config.port,
    nodeVersion: process.version,
    backupStatus: backup.backupStatus(ctx),
  }));
  get('/api/settings', () => getSettings(ctx));
  patch('/api/settings', (req) => updateSettings(ctx, body(req)));
  get('/api/dashboard', () => getDashboard(ctx));

  // ----- Hierarchy -----
  get('/api/tree', (req) => h.getTree(ctx, { includeArchived: req.query.includeArchived === '1' }));
  for (const level of ['program', 'semester', 'course', 'section'] as Level[]) {
    const base = `/api/${level}s`;
    post(base, (req, reply) => {
      reply.code(201);
      return h.createItem(ctx, level, body(req));
    });
    get(`${base}/:id`, (req) => ({
      item: h.getItem(ctx, level, req.params.id),
      breadcrumbs: h.breadcrumbs(ctx, level, req.params.id),
      state: h.itemState(ctx, level, req.params.id),
    }));
    patch(`${base}/:id`, (req) => h.updateItem(ctx, level, req.params.id, body(req)));
    post(`${base}/reorder`, (req) => {
      const b = body(req);
      h.reorder(ctx, level, (b.parentId as string | null) ?? null, b.ids as string[]);
      return { ok: true };
    });
  }
  post('/api/sections/:id/move', (req) => h.moveItem(ctx, 'section', req.params.id, parse(zId, body(req).courseId)));
  post('/api/courses/:id/move', (req) => h.moveItem(ctx, 'course', req.params.id, parse(zId, body(req).semesterId)));
  post('/api/courses/:id/duplicate', (req, reply) => {
    reply.code(201);
    const b = body(req);
    return h.duplicateCourse(ctx, req.params.id, { semesterId: b.semesterId as string, copyProgress: b.copyProgress === true, title: b.title as string | undefined });
  });

  // ----- Trash -----
  get('/api/impact/:type/:id', (req) => h.impactOf(ctx, trashType(req.params.type), req.params.id));
  del('/api/items/:type/:id', (req) => {
    h.moveToTrash(ctx, trashType(req.params.type), req.params.id);
    return { ok: true };
  });
  get('/api/trash', () => h.listTrash(ctx));
  post('/api/trash/restore', (req) => {
    const b = body(req);
    h.restoreFromTrash(ctx, trashType(String(b.type)), parse(zId, b.id));
    return { ok: true };
  });
  del('/api/trash/:type/:id', (req) => {
    h.purge(ctx, trashType(req.params.type), req.params.id);
    return { ok: true };
  });
  post('/api/trash/empty', () => ({ removed: h.emptyTrash(ctx) }));

  // ----- Cards -----
  get('/api/cards', (req) => {
    const q = req.query;
    return cards.listCards(ctx, {
      sectionId: q.sectionId,
      courseId: q.courseId,
      semesterId: q.semesterId,
      programId: q.programId,
      q: q.q,
      filter: q.filter as cards.ListQuery['filter'],
      tag: q.tag,
      includeArchived: q.includeArchived === '1',
      sort: q.sort as cards.ListQuery['sort'],
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
  });
  post('/api/cards', (req, reply) => {
    reply.code(201);
    return cards.createCard(ctx, body(req));
  });
  post('/api/cards/reorder', (req) => cards.reorderCards(ctx, body(req)));
  get('/api/cards/:id', (req) => ({
    card: cards.getCard(ctx, req.params.id),
    breadcrumbs: h.breadcrumbs(ctx, 'section', cards.getCard(ctx, req.params.id).sectionId),
  }));
  patch('/api/cards/:id', (req) => cards.updateCard(ctx, req.params.id, body(req)));
  post('/api/cards/:id/duplicate', (req, reply) => {
    reply.code(201);
    return cards.duplicateCard(ctx, req.params.id);
  });
  post('/api/cards/bulk', (req) => cards.bulkCards(ctx, body(req)));
  get('/api/tags', () => cards.listTags(ctx));

  // ----- Drafts -----
  get('/api/drafts/:key', (req) => drafts.getDraft(ctx, req.params.key));
  put('/api/drafts/:key', (req) => drafts.putDraft(ctx, req.params.key, body(req)));
  del('/api/drafts/:key', (req) => {
    drafts.deleteDraft(ctx, req.params.key);
    return { ok: true };
  });

  // ----- Media -----
  post('/api/media', async (req, reply) => {
    const { buffer, filename } = await readUpload(req, MAX_MEDIA_BYTES);
    reply.code(201);
    return saveMedia(ctx, buffer, filename);
  });

  // ----- Sessions -----
  post('/api/sessions/preview', (req) => sessions.previewSession(ctx, body(req)));
  post('/api/sessions', (req, reply) => {
    reply.code(201);
    return sessions.createSession(ctx, body(req));
  });
  get('/api/sessions', (req) => sessions.listSessions(ctx, req.query.limit ? Number(req.query.limit) : 20));
  get('/api/sessions/open', () => sessions.getOpenSession(ctx));
  get('/api/sessions/:id', (req) => sessions.getSessionState(ctx, req.params.id));
  post('/api/sessions/:id/reveal', (req) => sessions.reveal(ctx, req.params.id, body(req)));
  post('/api/sessions/:id/hint', (req) => sessions.showHint(ctx, req.params.id));
  post('/api/sessions/:id/rate', (req) => sessions.rateCard(ctx, req.params.id, body(req)));
  post('/api/sessions/:id/undo', (req) => sessions.undoLast(ctx, req.params.id, body(req)));
  post('/api/sessions/:id/relax', (req) => sessions.relaxGap(ctx, req.params.id, body(req)));
  post('/api/sessions/:id/pause', (req) => sessions.pauseSession(ctx, req.params.id));
  post('/api/sessions/:id/resume', (req) => sessions.resumeSession(ctx, req.params.id));
  post('/api/sessions/:id/end', (req) => sessions.endSession(ctx, req.params.id));
  get('/api/sessions/:id/results', (req) => sessions.sessionResults(ctx, req.params.id));

  // ----- Stats -----
  get('/api/stats', (req) =>
    getStats(ctx, {
      from: req.query.from,
      to: req.query.to,
      programId: req.query.programId,
      semesterId: req.query.semesterId,
      courseId: req.query.courseId,
    }),
  );

  // ----- Backup, restore, import, export -----
  get('/api/export/full', (_req, reply) => {
    const { filename, buffer } = backup.exportFull(ctx);
    return download(reply, filename, 'application/zip', buffer);
  });
  get('/api/export/course/:id', (req, reply) => {
    const { filename, buffer } = backup.exportCourse(ctx, req.params.id);
    return download(reply, filename, 'application/zip', buffer);
  });
  get('/api/export/csv', (req, reply) => {
    const { filename, text } = csv.exportCsv(ctx, { courseId: req.query.courseId, sectionId: req.query.sectionId });
    return download(reply, filename, 'text/csv; charset=utf-8', text);
  });
  post('/api/restore/preview', async (req) => {
    const { buffer } = await readUpload(req, 1024 * 1024 * 1024);
    return backup.previewArchive(ctx, buffer);
  });
  post('/api/restore/apply', async (req) => {
    const b = parse(z.object({ token: z.string(), confirm: z.literal(true) }), body(req));
    return backup.applyFullRestore(ctx, b.token);
  });
  post('/api/import/package', (req, reply) => {
    const b = parse(z.object({ token: z.string(), semesterId: zId, includeSchedules: z.boolean().default(false) }), body(req));
    reply.code(201);
    return backup.importCoursePackage(ctx, b.token, b);
  });
  get('/api/snapshots', () => backup.listSnapshots(ctx));
  post('/api/snapshots', async (_req, reply) => {
    reply.code(201);
    return backup.runAutoBackup(ctx, { force: true });
  });
  post('/api/snapshots/:name/preview', (req) => backup.previewSnapshot(ctx, req.params.name));
  post('/api/import/csv/inspect', (req) => csv.inspectCsv(String(body(req).text ?? '')));
  post('/api/import/csv/preview', (req) => csv.previewCsv(ctx, body(req)));
  post('/api/import/csv/apply', (req) => csv.applyCsv(ctx, body(req)));

  // ----- Demo -----
  post('/api/demo', (_req, reply) => {
    reply.code(201);
    return demo.loadDemo(ctx);
  });
  del('/api/demo', () => demo.removeDemo(ctx));
}
