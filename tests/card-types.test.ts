import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../server/db/migrations.ts';
import { Canvas } from '../server/lib/png.ts';
import { makeApp, revealAndRate, seedHierarchy, sessionRequest, tempDir, type TestApp } from './helpers.ts';

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

const extras = { explanation: '', hint: '', source: '' };
const cardsOf = (a: TestApp, noteId: string) =>
  a.ctx.db.prepare('SELECT id, variant, retired_at, deleted_at FROM cards WHERE note_id = ? ORDER BY variant_order').all(noteId) as {
    id: string;
    variant: string;
    retired_at: string | null;
    deleted_at: string | null;
  }[];

async function cloze(a: TestApp, sectionId: string, text: string) {
  const r = await a.api('POST', '/api/notes', { sectionId, kind: 'cloze', fields: { ...extras, text } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

describe('cloze notes keep history through edits', () => {
  it('retires a removed gap and restores the same card with its schedule when it returns', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [0]);
    const sec = h.sections[0].id;
    const created = await cloze(a, sec, 'A {{c1::one}} B {{c2::two}} C {{c3::three}}');
    expect(created.sync).toMatchObject({ created: 3 });
    const noteId = created.note.id;
    const before = cardsOf(a, noteId);
    expect(before.map((c) => c.variant)).toEqual(['c1', 'c2', 'c3']);

    // Study every gap once in a scheduled session (one card per note is off to get all three).
    const s = (await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [sec] }, { size: 3, filters: { includeNew: true, tags: [], bookmarkedOnly: false, status: 'any', weakBasis: 'all', oneCardPerNote: false } }))).body;
    expect(s.progress.selected).toBe(3);
    expect(s.current.snapshot.render).toMatchObject({ type: 'cloze', ord: 1 });
    expect(s.current.snapshot.variantLabel).toBe('Cloze 1');
    for (let i = 0; i < 3; i++) await revealAndRate(a, s.id, 3);
    const c2 = before[1].id;
    const schedBefore = (await a.api('GET', `/api/cards/${c2}`)).body.card.schedule;
    expect(schedBefore).toMatchObject({ intervalDays: 4 });

    // Remove c2: it is retired, hidden from lists, but keeps its schedule.
    const edit1 = await a.api('PATCH', `/api/notes/${noteId}`, { fields: { text: 'A {{c1::one}} B two C {{c3::three}}' }, revision: created.note.revision });
    expect(edit1.status).toBe(200);
    expect(edit1.body.sync).toMatchObject({ retired: 1, created: 0 });
    expect((await a.api('GET', `/api/cards?sectionId=${sec}`)).body.total).toBe(2);
    expect((await a.api('GET', `/api/cards/${c2}`)).status).toBe(404);
    expect(edit1.body.note.cards.find((c: { variant: string }) => c.variant === 'c2')).toMatchObject({ retired: true });
    // The other cards are the same rows (same ids) as before.
    expect(cardsOf(a, noteId).filter((c) => !c.retired_at).map((c) => c.id)).toEqual([before[0].id, before[2].id]);

    // Bring c2 back: same card id, same schedule, no new card.
    const edit2 = await a.api('PATCH', `/api/notes/${noteId}`, { fields: { text: 'A {{c1::one}} B {{c2::two}} C {{c3::three}}' }, revision: edit1.body.note.revision });
    expect(edit2.body.sync).toMatchObject({ restored: 1, created: 0 });
    expect((await a.api('GET', `/api/cards/${c2}`)).body.card.schedule).toEqual(schedBefore);
  });

  it('rejects broken cloze text with a readable message and enforces edit revisions', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [0]);
    const bad = await a.api('POST', '/api/notes', { sectionId: h.sections[0].id, kind: 'cloze', fields: { ...extras, text: 'no gaps here' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/at least one cloze/);
    const ok = await cloze(a, h.sections[0].id, '{{c1::x}}');
    await a.api('PATCH', `/api/notes/${ok.note.id}`, { fields: { text: '{{c1::y}}' } });
    const stale = await a.api('PATCH', `/api/notes/${ok.note.id}`, { fields: { text: '{{c1::z}}' }, revision: ok.note.revision });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('revision_conflict');
  });
});

describe('reverse cards', () => {
  it('turns the reverse card off and on without losing its history', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [0]);
    const card = (await a.api('POST', '/api/cards', { sectionId: h.sections[0].id, front: 'Stride', back: 'Step size', reverse: true })).body;
    expect(card.siblingCount).toBe(2);
    const note = (await a.api('GET', `/api/notes/${card.noteId}`)).body;
    const reverseId = note.cards.find((c: { variant: string }) => c.variant === 'reverse').id;
    const rev = (await a.api('GET', `/api/cards/${reverseId}`)).body.card;
    expect([rev.front, rev.back, rev.variantLabel]).toEqual(['Step size', 'Stride', 'Reverse']);
    const off = (await a.api('PATCH', `/api/notes/${card.noteId}`, { options: { reverse: false } })).body;
    expect(off.sync.retired).toBe(1);
    const on = (await a.api('PATCH', `/api/notes/${card.noteId}`, { options: { reverse: true } })).body;
    expect(on.sync.restored).toBe(1);
    expect(on.note.cards.find((c: { variant: string }) => c.variant === 'reverse').id).toBe(reverseId);
  });

  it('studies only one card per note by default, and every card when asked', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [0]);
    const sec = h.sections[0].id;
    await a.api('POST', '/api/cards', { sectionId: sec, front: 'Q', back: 'A', reverse: true });
    await cloze(a, sec, '{{c1::a}} {{c2::b}} {{c3::c}}');
    const one = (await a.api('POST', '/api/sessions/preview', sessionRequest({ sectionIds: [sec] }))).body;
    expect(one.available).toBe(2);
    const all = (await a.api('POST', '/api/sessions/preview', sessionRequest({ sectionIds: [sec] }, { filters: { includeNew: true, tags: [], bookmarkedOnly: false, status: 'any', weakBasis: 'all', oneCardPerNote: false } }))).body;
    expect(all.available).toBe(5);
  });
});

describe('image occlusion', () => {
  it('keeps a card when its box moves and retires it when the box is deleted', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [0]);
    const img = new Canvas(40, 30, [200, 200, 200]).toPng();
    const media = (await a.upload('/api/media', 'fig.png', img, 'image/png')).body;
    const masks = [
      { id: 'box-aaaa', x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: 'Left' },
      { id: 'box-bbbb', x: 0.6, y: 0.5, w: 0.2, h: 0.2, label: 'Right' },
    ];
    const created = (await a.api('POST', '/api/notes', { sectionId: h.sections[0].id, kind: 'occlusion', fields: { ...extras, image: media.url, header: 'Parts', masks }, options: { occlusionMode: 'hide-one' } })).body;
    const [left, right] = cardsOf(a, created.note.id);
    expect([left.variant, right.variant]).toEqual(['m:box-aaaa', 'm:box-bbbb']);
    const leftCard = (await a.api('GET', `/api/cards/${left.id}`)).body.card;
    expect(leftCard.front).toContain(media.url); // the image is referenced, so backups include it
    const moved = (await a.api('PATCH', `/api/notes/${created.note.id}`, { fields: { masks: [{ ...masks[0], x: 0.15 }] } })).body;
    expect(moved.sync).toMatchObject({ updated: 1, retired: 1, created: 0 });
    expect(cardsOf(a, created.note.id).find((c) => c.variant === 'm:box-aaaa')!.id).toBe(left.id);
    const remote = await a.api('POST', '/api/notes', { sectionId: h.sections[0].id, kind: 'occlusion', fields: { ...extras, image: 'https://example.com/x.png', masks } });
    expect(remote.status).toBe(400);
  });
});

describe('templates evolve safely', () => {
  async function setup(a: TestApp) {
    const h = await seedHierarchy(a, [0]);
    const tpl = (await a.api('POST', '/api/templates', {
      name: 'Vocabulary',
      fields: [{ name: 'Term' }, { name: 'Definition' }],
      cards: [{ name: 'Term → definition', front: '{{Term}}', back: '{{FrontSide}}\n\n{{Definition}}' }],
    })).body;
    const [term, def] = tpl.fields.map((f: { id: string }) => f.id);
    const notes = [];
    for (const w of ['entropy', 'enthalpy']) {
      notes.push((await a.api('POST', '/api/notes', { sectionId: h.sections[0].id, kind: 'template', templateId: tpl.id, fields: { ...extras, values: { [term]: w, [def]: `${w} definition` } } })).body);
    }
    return { h, tpl, term, def, notes };
  }

  it('previews and applies a new card type, renames fields safely, and retires/restores card types', async () => {
    const a = await app();
    const { tpl, term, def, notes } = await setup(a);
    const withReverse = {
      name: 'Vocabulary',
      revision: tpl.revision,
      fields: [{ id: term, name: 'Term' }, { id: def, name: 'Definition' }],
      cards: [...tpl.cards, { name: 'Definition → term', front: '{{Definition}}', back: '{{Term}}' }],
    };
    const dry = (await a.api('PATCH', `/api/templates/${tpl.id}?dryRun=1`, withReverse)).body;
    expect(dry.impact).toMatchObject({ notes: 2, created: 2, retired: 0 });
    // A dry run changes nothing.
    expect((await a.api('GET', `/api/templates/${tpl.id}`)).body.cards).toHaveLength(1);
    expect(cardsOf(a, notes[0].note.id)).toHaveLength(1);
    const applied = (await a.api('PATCH', `/api/templates/${tpl.id}`, withReverse)).body;
    expect(applied.impact).toMatchObject({ created: 2 });
    expect(cardsOf(a, notes[0].note.id).map((c) => c.variant)).toHaveLength(2);

    // Rename "Term" to "Word" (placeholders updated): values survive, cards only re-render.
    const t2 = applied.template;
    const renamed = {
      name: 'Vocabulary',
      fields: [{ id: term, name: 'Word' }, { id: def, name: 'Definition' }],
      cards: t2.cards.map((c: { front: string; back: string }) => ({ ...c, front: c.front.replace('{{Term}}', '{{Word}}'), back: c.back.replace('{{Term}}', '{{Word}}') })),
    };
    const r = (await a.api('PATCH', `/api/templates/${tpl.id}`, renamed)).body;
    expect(r.impact).toMatchObject({ created: 0, retired: 0 });
    const firstCard = cardsOf(a, notes[0].note.id)[0];
    expect((await a.api('GET', `/api/cards/${firstCard.id}`)).body.card.front).toBe('entropy');

    // Remove the second card type (kept as removed), then restore it: same cards come back.
    const second = r.template.cards[1];
    const removed = (await a.api('PATCH', `/api/templates/${tpl.id}`, { ...renamed, cards: [renamed.cards[0], { ...second, removed: true }] })).body;
    expect(removed.impact.retired).toBe(2);
    expect(removed.template.cards.find((c: { id: string }) => c.id === second.id).removed).toBe(true);
    const restored = (await a.api('PATCH', `/api/templates/${tpl.id}`, { ...renamed, cards: [renamed.cards[0], { ...second, removed: false }] })).body;
    expect(restored.impact.restored).toBe(2);
  });

  it('refuses invalid templates, deleting a template in use, and new notes on an archived template', async () => {
    const a = await app();
    const { h, tpl, term } = await setup(a);
    const invalid = await a.api('POST', '/api/templates', { name: 'Bad', fields: [{ name: 'A' }], cards: [{ name: 'C', front: '{{Missing}}', back: '' }] });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.message).toMatch(/doesn’t exist/);
    const del = await a.api('DELETE', `/api/templates/${tpl.id}`);
    expect(del.status).toBe(409);
    await a.api('PATCH', `/api/templates/${tpl.id}`, { archived: true });
    const blocked = await a.api('POST', '/api/notes', { sectionId: h.sections[0].id, kind: 'template', templateId: tpl.id, fields: { ...extras, values: { [term]: 'x' } } });
    expect(blocked.status).toBe(400);
    expect((await a.api('GET', '/api/templates')).body).toHaveLength(0);
    expect((await a.api('GET', '/api/templates?includeArchived=1')).body).toHaveLength(1);
  });
});

describe('notes move, reorder and delete as a whole', () => {
  it('trashes, restores and purges every card of a note together', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [1]);
    const sec = h.sections[0].id;
    const n = await cloze(a, sec, '{{c1::a}} {{c2::b}}');
    const [c1, c2] = cardsOf(a, n.note.id);
    expect((await a.api('GET', `/api/impact/card/${c2.id}`)).body.cards).toBe(2);
    await a.api('DELETE', `/api/items/card/${c2.id}`);
    expect((await a.api('GET', `/api/cards?sectionId=${sec}`)).body.total).toBe(1);
    const trash = (await a.api('GET', '/api/trash')).body.filter((t: { type: string }) => t.type === 'card');
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ title: 'a b', impact: { cards: 2 } });
    await a.api('POST', '/api/trash/restore', { type: 'card', id: trash[0].id });
    expect((await a.api('GET', `/api/cards?sectionId=${sec}`)).body.total).toBe(3);
    await a.api('DELETE', `/api/items/card/${c1.id}`);
    expect((await a.api('DELETE', `/api/trash/card/${c1.id}`)).status).toBe(200);
    expect(a.ctx.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE id = ?').get(n.note.id)).toEqual({ n: 0 });
    expect(cardsOf(a, n.note.id)).toHaveLength(0);
  });

  it('moves and reorders siblings together', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [1, 0]);
    const [s1, s2] = h.sections.map((s) => s.id);
    const n = await cloze(a, s1, '{{c1::a}} {{c2::b}}');
    const [c1, c2] = cardsOf(a, n.note.id);
    await a.api('POST', '/api/cards/reorder', { sectionId: s1, ids: [c2.id, h.sections[0].cardIds[0]] });
    const order = (await a.api('GET', `/api/cards?sectionId=${s1}`)).body.cards.map((c: { id: string }) => c.id);
    expect(order).toEqual([c1.id, c2.id, h.sections[0].cardIds[0]]);
    await a.api('POST', '/api/cards/bulk', { ids: [c1.id], action: 'move', sectionId: s2 });
    expect((await a.api('GET', `/api/cards?sectionId=${s2}`)).body.total).toBe(2);
    expect((await a.api('GET', `/api/notes/${n.note.id}`)).body.sectionId).toBe(s2);
  });

  it('applies tags to every card of a note', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [0]);
    const n = await cloze(a, h.sections[0].id, '{{c1::a}} {{c2::b}}');
    const [c1, c2] = cardsOf(a, n.note.id);
    await a.api('POST', '/api/cards/bulk', { ids: [c1.id], action: 'addTags', tags: ['exam'] });
    expect((await a.api('GET', `/api/cards/${c2.id}`)).body.card.tags).toEqual(['exam']);
  });
});

describe('upgrading existing data', () => {
  it('migrates a schema-2 database: every card becomes a basic note with the same id', async () => {
    const dir = tempDir();
    const db = new Database(path.join(dir, 'recall.sqlite'));
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 2)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, '2026-10-01T00:00:00Z');
    }
    const ts = '2026-10-01T00:00:00.000Z';
    db.prepare("INSERT INTO programs (id, title, created_at, updated_at) VALUES ('p', 'P', ?, ?)").run(ts, ts);
    db.prepare("INSERT INTO semesters (id, program_id, title, created_at, updated_at) VALUES ('s', 'p', 'S', ?, ?)").run(ts, ts);
    db.prepare("INSERT INTO courses (id, semester_id, title, created_at, updated_at) VALUES ('c', 's', 'C', ?, ?)").run(ts, ts);
    db.prepare("INSERT INTO sections (id, course_id, title, created_at, updated_at) VALUES ('x', 'c', 'X', ?, ?)").run(ts, ts);
    db.prepare("INSERT INTO cards (id, section_id, front, back, explanation, created_at, updated_at) VALUES ('old-card', 'x', 'Old Q', 'Old A', 'why', ?, ?)").run(ts, ts);
    db.close();
    const a = await app({ dataDir: dir });
    const { card, note } = (await a.api('GET', '/api/cards/old-card')).body;
    expect(card).toMatchObject({ noteId: 'old-card', kind: 'basic', variant: 'main', front: 'Old Q' });
    expect(note.fields).toMatchObject({ front: 'Old Q', back: 'Old A', explanation: 'why' });
    // A pre-migration snapshot was taken.
    expect(fs.readdirSync(path.join(dir, 'backups')).some((f) => f.startsWith('pre-migration-v2'))).toBe(true);
  });

  it('restores a backup made before notes existed', async () => {
    const a = await app();
    await seedHierarchy(a, [2]);
    const exp = await a.raw('GET', '/api/export/full');
    const files = unzipSync(new Uint8Array(exp.buffer));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    const data = JSON.parse(new TextDecoder().decode(files['data.json']));
    // Turn it into a schema-2 backup: no notes tables, no note columns on cards.
    delete data.tables.notes;
    delete data.tables.note_templates;
    data.tables.cards = data.tables.cards.map((c: Record<string, unknown>) => {
      const { note_id: _n, variant: _v, variant_order: _o, variant_label: _l, render_json: _r, retired_at: _t, ...rest } = c;
      return rest;
    });
    manifest.schemaVersion = 2;
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    files['data.json'] = strToU8(JSON.stringify(data));
    const b = await app();
    const prev = await b.upload('/api/restore/preview', 'old.zip', Buffer.from(zipSync(files)));
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    expect((await b.api('POST', '/api/restore/apply', { token: prev.body.token, confirm: true })).status).toBe(200);
    const list = (await b.api('GET', '/api/cards')).body;
    expect(list.total).toBe(2);
    expect(list.cards[0]).toMatchObject({ kind: 'basic', noteId: list.cards[0].id });
  });

  it('moves cloze, occlusion and template notes in a course package', async () => {
    const a = await app();
    await a.api('POST', '/api/demo');
    const tree = (await a.api('GET', '/api/tree')).body;
    const course = tree[0].semesters[0].courses[0];
    const before = (await a.api('GET', `/api/cards?courseId=${course.id}`)).body;
    const kinds = new Set(before.cards.map((c: { kind: string }) => c.kind));
    expect([...kinds].sort()).toEqual(['basic', 'cloze', 'occlusion', 'template']);
    const exp = await a.raw('GET', `/api/export/course/${course.id}`);
    const b = await app();
    const target = await seedHierarchy(b, [0]);
    const prev = await b.upload('/api/restore/preview', 'course.zip', exp.buffer);
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    const imp = await b.api('POST', '/api/import/package', { token: prev.body.token, semesterId: target.semester.id, includeSchedules: false });
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    const after = (await b.api('GET', `/api/cards?courseId=${imp.body.courseId}`)).body;
    expect(after.total).toBe(before.total);
    expect((await b.api('GET', '/api/templates')).body).toHaveLength(1);
    const occl = after.cards.find((c: { kind: string }) => c.kind === 'occlusion');
    expect((await b.raw('GET', occl.front.match(/\/media\/[^)]+/)[0])).status).toBe(200);
  });
});

describe('CSV with card types', () => {
  it('imports basic, reverse and cloze rows and exports the type column', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [0]);
    const text = ['front,back,type', 'Q1,A1,', 'Q2,A2,reverse', '"The {{c1::sun}} rises in the {{c2::east}}",extra info,cloze', '"no gap",,cloze', 'X,Y,occlusion'].join('\n');
    const req = { text, courseId: h.course.id, hasHeader: true, mapping: { front: 0, back: 1, type: 2 }, defaultSectionId: h.sections[0].id };
    const prev = (await a.api('POST', '/api/import/csv/preview', req)).body;
    expect(prev).toMatchObject({ valid: 3, errors: 2 });
    expect(prev.rows.map((r: { type: string }) => r.type)).toEqual(['basic', 'reverse', 'cloze', 'cloze', 'basic']);
    expect(prev.rows[4].errors[0]).toMatch(/course package/);
    const done = (await a.api('POST', '/api/import/csv/apply', req)).body;
    expect(done.imported).toBe(3);
    expect((await a.api('GET', `/api/cards?sectionId=${h.sections[0].id}`)).body.total).toBe(1 + 2 + 2);
    const csv = (await a.raw('GET', `/api/export/csv?sectionId=${h.sections[0].id}`)).buffer.toString('utf8');
    expect(csv.split('\r\n')[0]).toBe('﻿front,back,section,tags,source,explanation,hint,type');
    expect(csv).toContain('Q2,A2,');
    expect(csv).toMatch(/reverse/);
    expect(csv).toContain('The {{c1::sun}} rises in the {{c2::east}}');
  });
});
