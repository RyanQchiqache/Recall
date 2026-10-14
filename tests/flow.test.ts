import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../server/app.ts';
import { Canvas } from '../server/lib/png.ts';
import { HOST, key, makeApp, makeClock, sessionRequest, tempDir, testConfig, type TestApp } from './helpers.ts';

let apps: TestApp[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
});

describe('create card → study → reload / restart', () => {
  it('serves frontend assets added by a rebuild while the server is running', async () => {
    const dataDir = tempDir();
    const distDir = path.join(dataDir, 'dist');
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<div id="root"></div>');
    const config = { ...testConfig(dataDir), distDir };
    const built = await buildApp({ config, log: () => {} });
    try {
      fs.writeFileSync(path.join(distDir, 'assets', 'rebuilt.js'), 'window.rebuilt = true;');
      const asset = await built.app.inject({ method: 'GET', url: '/assets/rebuilt.js', headers: { host: HOST } });

      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('javascript');
      expect(asset.body).toBe('window.rebuilt = true;');
    } finally {
      await built.close();
    }
  });

  it('runs the essential flow end to end and persists everything', async () => {
    const clock = makeClock('2026-10-13T08:00:00.000Z');
    const a = await makeApp({ clock });
    const p = (await a.api('POST', '/api/programs', { title: 'M.Sc. Informatics' })).body;
    const s = (await a.api('POST', '/api/semesters', { programId: p.id, title: 'Winter 2026/27', startDate: '2026-10-01', endDate: '2027-03-31' })).body;
    const c1 = (await a.api('POST', '/api/courses', { semesterId: s.id, title: 'Computer Vision III', color: 'teal', icon: 'camera' })).body;
    const c2 = (await a.api('POST', '/api/courses', { semesterId: s.id, title: 'Machine Learning' })).body;
    const sec = [] as { id: string }[];
    for (const [course, title] of [[c1, 'Week 01'], [c1, 'Week 02'], [c2, 'Week 01']] as const) {
      sec.push((await a.api('POST', '/api/sections', { courseId: course.id, title })).body);
    }
    const img = new Canvas(16, 16, [255, 255, 255]).toPng();
    const media = (await a.upload('/api/media', 'figure.png', img, 'image/png')).body;
    expect(media.url).toMatch(/^\/media\/[0-9a-f-]+\.png$/);

    // Draft survives a reload before saving.
    await a.api('PUT', '/api/drafts/new:' + sec[0].id, { front: 'half-written', back: '' });
    expect((await a.api('GET', '/api/drafts/new:' + sec[0].id)).body.payload.front).toBe('half-written');

    const front = 'Explain $\\operatorname{IoU}(A,B) = \\frac{|A \\cap B|}{|A \\cup B|}$';
    const back = `\`\`\`python\ndef iou(a, b): ...\n\`\`\`\n\n![boxes](${media.url})`;
    const card = (await a.api('POST', '/api/cards', { sectionId: sec[0].id, front, back, tags: ['cv'], hint: 'ratio of areas' })).body;
    expect(card).toMatchObject({ front, back, status: 'new', tags: ['cv'] });
    await a.api('POST', '/api/cards', { sectionId: sec[1].id, front: 'Second', back: 'Two' });

    const session = (await a.api('POST', '/api/sessions', sessionRequest({ courseIds: [c1.id] }, { size: 2 }))).body;
    expect(session.current.snapshot.front).toBe(front);

    // Edit the card elsewhere: the running session keeps its snapshot.
    await a.api('PATCH', `/api/cards/${card.id}`, { front: 'Edited front', revision: card.revision });
    const st = (await a.api('GET', `/api/sessions/${session.id}`)).body;
    expect(st.current.snapshot.front).toBe(front);
    expect(st.current.editedSinceStart).toBe(true);

    const rev = (await a.api('POST', `/api/sessions/${session.id}/reveal`, { revision: st.revision })).body;
    await a.api('POST', `/api/sessions/${session.id}/rate`, { rating: 4, idempotencyKey: key(), revision: rev.revision });
    await a.close();

    // Restart: hierarchy, cards and session state are all still there.
    const b = await makeApp({ dataDir: a.dataDir, clock });
    apps.push(b);
    const tree = (await b.api('GET', '/api/tree')).body;
    expect(tree[0].semesters[0].courses.map((c: { title: string }) => c.title)).toEqual(['Computer Vision III', 'Machine Learning']);
    expect(tree[0].semesters[0].courses[0].sections.map((x: { title: string }) => x.title)).toEqual(['Week 01', 'Week 02']);
    const resumed = (await b.api('GET', '/api/sessions/open')).body;
    expect(resumed.id).toBe(session.id);
    expect(resumed.progress).toMatchObject({ selected: 2, attempted: 1, completed: 1, totalAttempts: 1 });
    expect((await b.api('GET', `/api/cards/${card.id}`)).body.card.schedule).toMatchObject({ intervalDays: 7, dueDate: '2026-10-20' });
    expect((await b.raw('GET', media.url)).status).toBe(200);

    // A week later the card is due again (calendar days in Europe/Berlin).
    clock.set('2026-10-19T21:59:59.000Z'); // 23:59:59 local on the 19th
    expect((await b.api('GET', `/api/cards/${card.id}`)).body.card.status).toBe('scheduled');
    clock.set('2026-10-19T22:00:00.000Z'); // 00:00 local on the 20th
    expect((await b.api('GET', `/api/cards/${card.id}`)).body.card.status).toBe('due');
  });

  it('rejects requests that do not come from the local app', async () => {
    const a = await makeApp();
    apps.push(a);
    const badHost = await a.app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example:4999' } });
    expect(badHost.statusCode).toBe(421);
    const crossOrigin = await a.app.inject({ method: 'POST', url: '/api/programs', payload: { title: 'x' }, headers: { host: HOST, origin: 'http://evil.example', 'x-recall-client': '1' } });
    expect(crossOrigin.statusCode).toBe(403);
    const noHeader = await a.app.inject({ method: 'POST', url: '/api/programs', payload: { title: 'x' }, headers: { host: HOST } });
    expect(noHeader.statusCode).toBe(403);
    const crossSite = await a.app.inject({ method: 'POST', url: '/api/programs', payload: { title: 'x' }, headers: { host: HOST, 'x-recall-client': '1', 'sec-fetch-site': 'cross-site' } });
    expect(crossSite.statusCode).toBe(403);
    const sameOrigin = await a.app.inject({ method: 'POST', url: '/api/programs', payload: { title: 'ok' }, headers: { host: HOST, origin: `http://${HOST}`, 'x-recall-client': '1' } });
    expect(sameOrigin.statusCode).toBe(201);
  });

  it('validates uploads by content and refuses path traversal', async () => {
    const a = await makeApp();
    apps.push(a);
    const html = await a.upload('/api/media', 'evil.png', Buffer.from('<svg onload=alert(1)>'), 'image/png');
    expect(html.status).toBe(415);
    const trav = await a.raw('GET', '/media/..%2Frecall.sqlite');
    expect(trav.status).toBe(404);
    // The URL is normalized to /recall.sqlite, which only reaches the SPA fallback page — never the database file.
    const trav2 = await a.raw('GET', '/media/../recall.sqlite');
    expect(trav2.buffer.subarray(0, 15).toString()).not.toBe('SQLite format 3');
  });

  it('supports trash with impact counts, restore and permanent deletion', async () => {
    const a = await makeApp();
    apps.push(a);
    const p = (await a.api('POST', '/api/programs', { title: 'P' })).body;
    const s = (await a.api('POST', '/api/semesters', { programId: p.id, title: 'S' })).body;
    const c = (await a.api('POST', '/api/courses', { semesterId: s.id, title: 'C' })).body;
    const sec = (await a.api('POST', '/api/sections', { courseId: c.id, title: 'W1' })).body;
    await a.api('POST', '/api/cards', { sectionId: sec.id, front: 'f', back: 'b' });
    expect((await a.api('GET', `/api/impact/course/${c.id}`)).body).toMatchObject({ sections: 1, cards: 1 });
    await a.api('DELETE', `/api/items/course/${c.id}`);
    expect((await a.api('GET', '/api/tree')).body[0].semesters[0].courses).toHaveLength(0);
    const trash = (await a.api('GET', '/api/trash')).body;
    expect(trash[0]).toMatchObject({ type: 'course', id: c.id, impact: { cards: 1 } });
    await a.api('POST', '/api/trash/restore', { type: 'course', id: c.id });
    expect((await a.api('GET', '/api/tree')).body[0].semesters[0].courses).toHaveLength(1);
    await a.api('DELETE', `/api/items/course/${c.id}`);
    expect((await a.api('DELETE', `/api/trash/course/${c.id}`)).status).toBe(200);
    expect((a.ctx.db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n).toBe(0);
  });

  it('loads and removes the demo course in one action', async () => {
    const a = await makeApp();
    apps.push(a);
    const own = (await a.api('POST', '/api/programs', { title: 'Mine' })).body;
    expect((await a.api('POST', '/api/demo')).status).toBe(201);
    expect((await a.api('POST', '/api/demo')).status).toBe(409);
    const dash = (await a.api('GET', '/api/dashboard')).body;
    expect(dash.demoLoaded).toBe(true);
    expect((await a.api('GET', '/api/cards?q=demo')).body.total).toBeGreaterThan(0);
    await a.api('DELETE', '/api/demo');
    const tree = (await a.api('GET', '/api/tree')).body;
    expect(tree.map((p: { id: string }) => p.id)).toEqual([own.id]);
    expect((a.ctx.db.prepare('SELECT COUNT(*) AS n FROM media_assets').get() as { n: number }).n).toBe(0);
  });
});
