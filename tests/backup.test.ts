import fs from 'node:fs';
import path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION } from '../server/db/migrations.ts';
import { Canvas } from '../server/lib/png.ts';
import { makeApp, revealAndRate, seedHierarchy, sessionRequest, type TestApp } from './helpers.ts';

let apps: TestApp[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
});
async function app(opts: Parameters<typeof makeApp>[0] = {}) {
  const a = await makeApp(opts);
  apps.push(a);
  return a;
}

function png(): Buffer {
  const c = new Canvas(8, 8, [10, 20, 30]);
  c.fillRect(2, 2, 4, 4, [200, 100, 50]);
  return c.toPng();
}

async function populated() {
  const a = await app();
  const h = await seedHierarchy(a, [3, 2]);
  const media = (await a.upload('/api/media', 'fig.png', png(), 'image/png')).body;
  const card = (await a.api('POST', '/api/cards', {
    sectionId: h.sections[0].id,
    front: `Equation $E = mc^2$ and image ![fig](${media.url})`,
    back: '```python\nprint("hi")\n```',
    tags: ['math', 'code'],
    source: 'Lecture 3, slide 24',
  })).body;
  const s = (await a.api('POST', '/api/sessions', sessionRequest({ courseIds: [h.course.id] }, { size: 6 }))).body;
  await revealAndRate(a, s.id, 3);
  await revealAndRate(a, s.id, 1);
  await a.api('PATCH', '/api/settings', { timeZone: 'Europe/London', appName: 'My Recall' });
  return { a, h, media, card, session: s };
}

describe('full backup round trip', () => {
  it('restores hierarchy, cards, media, schedules, history and settings into a clean data directory', async () => {
    const { a, media, card, session } = await populated();
    const exp = await a.raw('GET', '/api/export/full');
    expect(exp.status).toBe(200);
    expect(String(exp.headers['content-type'])).toContain('application/zip');
    const files = unzipSync(new Uint8Array(exp.buffer));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['manifest.json', 'data.json', `media/${media.filename}`]));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    expect(manifest).toMatchObject({ format: 'recall-backup', formatVersion: 1, kind: 'full', schemaVersion: LATEST_SCHEMA_VERSION });

    const b = await app();
    const prev = await b.upload('/api/restore/preview', 'backup.zip', exp.buffer, 'application/zip');
    expect(prev.status).toBe(200);
    expect(prev.body.counts).toMatchObject({ programs: 1, cards: 6, review_events: 2, media_assets: 1 });
    const applied = await b.api('POST', '/api/restore/apply', { token: prev.body.token, confirm: true });
    expect(applied.status).toBe(200);
    expect(applied.body.preRestoreSnapshot).toMatch(/^pre-restore-/);

    const tables = ['programs', 'semesters', 'courses', 'sections', 'note_templates', 'notes', 'cards', 'tags', 'card_tags', 'media_assets', 'card_schedules', 'study_sessions', 'session_cards', 'review_events'];
    for (const t of tables) {
      expect(b.ctx.db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()).toEqual(a.ctx.db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all());
    }
    const restoredCard = (await b.api('GET', `/api/cards/${card.id}`)).body.card;
    expect(restoredCard.tags).toEqual(['code', 'math']);
    expect(fs.readFileSync(path.join(b.dataDir, 'media', media.filename))).toEqual(fs.readFileSync(path.join(a.dataDir, 'media', media.filename)));
    expect((await b.raw('GET', media.url)).status).toBe(200);
    expect((await b.api('GET', '/api/settings')).body).toMatchObject({ timeZone: 'Europe/London', appName: 'My Recall' });
    // The open session survives and can be resumed.
    const st = (await b.api('GET', `/api/sessions/${session.id}`)).body;
    expect(st.progress.totalAttempts).toBe(2);
    // Search index was rebuilt.
    expect((await b.api('GET', '/api/cards?q=equation')).body.total).toBe(1);
  });

  it('leaves existing data intact when an archive has broken references', async () => {
    const { a } = await populated();
    const exp = await a.raw('GET', '/api/export/full');
    const files = unzipSync(new Uint8Array(exp.buffer));
    const data = JSON.parse(new TextDecoder().decode(files['data.json']));
    data.tables.cards[0].section_id = 'does-not-exist';
    files['data.json'] = strToU8(JSON.stringify(data));
    const broken = Buffer.from(zipSync(files));

    const b = await app();
    await seedHierarchy(b, [2]);
    const before = b.ctx.db.prepare('SELECT COUNT(*) AS n FROM cards').get();
    const prev = await b.upload('/api/restore/preview', 'broken.zip', broken);
    expect(prev.status).toBe(400);
    expect(b.ctx.db.prepare('SELECT COUNT(*) AS n FROM cards').get()).toEqual(before);
  });

  it('rejects future versions, traversal paths and fake media safely', async () => {
    const a = await app();
    const manifest = { format: 'recall-backup', formatVersion: 99, kind: 'full', schemaVersion: 1, appVersion: 'x', createdAt: '', counts: {}, includes: [], excludes: [], media: [] };
    const future = Buffer.from(zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'data.json': strToU8('{"tables":{}}') }));
    const r1 = await a.upload('/api/restore/preview', 'f.zip', future);
    expect(r1.status).toBe(400);
    expect(r1.body.error.message).toMatch(/newer/);

    const ok = { ...manifest, formatVersion: 1 };
    const traversal = Buffer.from(zipSync({ 'manifest.json': strToU8(JSON.stringify(ok)), 'data.json': strToU8('{"tables":{}}'), '../evil.txt': strToU8('x') }));
    const r2 = await a.upload('/api/restore/preview', 't.zip', traversal);
    expect(r2.status).toBe(400);
    expect(fs.existsSync(path.join(a.dataDir, '..', 'evil.txt'))).toBe(false);

    const fakeMedia = Buffer.from(zipSync({
      'manifest.json': strToU8(JSON.stringify(ok)),
      'data.json': strToU8('{"tables":{}}'),
      'media/01a134bd-d88b-7adf-91f4-8fd0c796f6be.png': strToU8('<script>alert(1)</script>'),
    }));
    const r3 = await a.upload('/api/restore/preview', 'm.zip', fakeMedia);
    expect(r3.status).toBe(400);

    const notZip = await a.upload('/api/restore/preview', 'x.zip', Buffer.from('hello'));
    expect(notZip.status).toBe(400);
  });

  it('creates consistent SQLite snapshots with retention, and can restore one', async () => {
    const { a } = await populated();
    await a.api('PATCH', '/api/settings', { backup: { retention: 2 } });
    for (let i = 0; i < 4; i++) {
      a.clock.advance(25 * 3600_000);
      const { runAutoBackup } = await import('../server/services/backup.ts');
      await runAutoBackup(a.ctx);
    }
    const snaps = (await a.api('GET', '/api/snapshots')).body;
    expect(snaps.filter((s: { kind: string }) => s.kind === 'auto')).toHaveLength(2);
    const status = (await a.api('GET', '/api/system')).body.backupStatus;
    expect(status.lastSuccessAt).not.toBeNull();

    const cardsBefore = (a.ctx.db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n;
    const sectionId = (a.ctx.db.prepare('SELECT id FROM sections LIMIT 1').get() as { id: string }).id;
    await a.api('POST', '/api/cards', { sectionId, front: 'after snapshot', back: 'x' });
    const name = snaps.find((s: { kind: string }) => s.kind === 'auto').name;
    const prev = await a.api('POST', `/api/snapshots/${name}/preview`);
    expect(prev.status).toBe(200);
    expect((await a.api('POST', '/api/restore/apply', { token: prev.body.token, confirm: true })).status).toBe(200);
    expect((a.ctx.db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n).toBe(cardsBefore);
  });
});

describe('course package', () => {
  it('exports one course with its media and imports it as a fresh copy', async () => {
    const { a, h, media } = await populated();
    const exp = await a.raw('GET', `/api/export/course/${h.course.id}`);
    const files = unzipSync(new Uint8Array(exp.buffer));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    expect(manifest.kind).toBe('course');
    expect(manifest.excludes.join(' ')).toMatch(/Review history/);
    expect(Object.keys(files)).toContain(`media/${media.filename}`);

    const b = await app();
    const target = await seedHierarchy(b, [0]);
    const prev = await b.upload('/api/restore/preview', 'course.zip', exp.buffer);
    expect(prev.body.kind).toBe('course');
    const imp = await b.api('POST', '/api/import/package', { token: prev.body.token, semesterId: target.semester.id, includeSchedules: false });
    expect(imp.status).toBe(201);
    const cards = (await b.api('GET', `/api/cards?courseId=${imp.body.courseId}`)).body;
    expect(cards.total).toBe(6);
    expect(cards.cards.every((c: { schedule: unknown }) => c.schedule === null)).toBe(true);
    expect((await b.raw('GET', media.url)).status).toBe(200);
  });
});
