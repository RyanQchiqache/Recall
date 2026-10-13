import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, revealAndRate, seedHierarchy, sessionRequest, type TestApp } from './helpers.ts';

let apps: TestApp[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
});
async function app() {
  const a = await makeApp();
  apps.push(a);
  return a;
}

describe('items in the trash stay put', () => {
  it('refuses to move a section or course that is in the trash', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [1, 1]);
    const other = (await a.api('POST', '/api/courses', { semesterId: h.semester.id, title: 'Other' })).body;
    const otherSem = (await a.api('POST', '/api/semesters', { programId: h.program.id, title: 'SS 27' })).body;

    await a.api('DELETE', `/api/items/section/${h.sections[1].id}`);
    expect((await a.api('POST', `/api/sections/${h.sections[1].id}/move`, { courseId: other.id })).status).toBe(400);

    await a.api('DELETE', `/api/items/course/${other.id}`);
    expect((await a.api('POST', `/api/courses/${other.id}/move`, { semesterId: otherSem.id })).status).toBe(400);

    // The trashed section is still where it was.
    const trash = (await a.api('GET', '/api/trash')).body as { id: string; context: string }[];
    expect(trash.find((t) => t.id === h.sections[1].id)?.context).toContain('Course A');
  });

  it('refuses to duplicate a course that is in the trash', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [2]);
    await a.api('DELETE', `/api/items/course/${h.course.id}`);
    const dup = await a.api('POST', `/api/courses/${h.course.id}/duplicate`, { semesterId: h.semester.id });
    expect(dup.status).toBe(400);
  });

  it('refuses to edit a card whose section is in the trash', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [1]);
    await a.api('DELETE', `/api/items/section/${h.sections[0].id}`);
    const res = await a.api('PATCH', `/api/cards/${h.sections[0].cardIds[0]}`, { front: 'changed' });
    expect(res.status).toBe(400);
  });
});

describe('bulk card actions and edit conflicts', () => {
  for (const action of ['bookmark', 'unbookmark', 'suspend', 'unsuspend'] as const) {
    it(`bulk ${action} bumps the revision so a stale editor cannot overwrite it`, async () => {
      const a = await app();
      const h = await seedHierarchy(a, [1]);
      const id = h.sections[0].cardIds[0];
      if (action === 'unbookmark') await a.api('PATCH', `/api/cards/${id}`, { bookmarked: true });
      if (action === 'unsuspend') await a.api('PATCH', `/api/cards/${id}`, { suspended: true });
      const opened = (await a.api('GET', `/api/cards/${id}`)).body.card;

      await a.api('POST', '/api/cards/bulk', { ids: [id], action });
      const after = (await a.api('GET', `/api/cards/${id}`)).body.card;
      expect(after.revision).toBe(opened.revision + 1);

      // An editor opened before the bulk action saves its stale form.
      const stale = await a.api('PATCH', `/api/cards/${id}`, {
        revision: opened.revision,
        front: 'edited in old tab',
        bookmarked: opened.bookmarked,
        suspended: opened.suspendedAt !== null,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('revision_conflict');
    });
  }
});

describe('undo after the card was moved to the trash', () => {
  it('refuses instead of reopening the session on a trashed card', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [2]);
    const s = (await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { size: 2 }))).body;
    await revealAndRate(a, s.id, 4);
    const { cardId } = await revealAndRate(a, s.id, 4);
    expect((await a.api('GET', `/api/sessions/${s.id}`)).body.status).toBe('completed');

    expect((await a.api('DELETE', `/api/items/card/${cardId}`)).status).toBe(200);
    const undo = await a.api('POST', `/api/sessions/${s.id}/undo`);
    expect(undo.status).toBe(409);
    expect(undo.body.error.code).toBe('card_in_trash');
    expect((await a.api('GET', '/api/sessions/open')).body).toBeNull();
    expect((await a.api('GET', `/api/sessions/${s.id}`)).body.status).toBe('completed');
  });
});

describe('course package import', () => {
  async function tamperedPackage(a: TestApp, courseId: string, edit: (data: any) => void): Promise<Buffer> {
    const exp = await a.raw('GET', `/api/export/course/${courseId}`);
    const files = unzipSync(new Uint8Array(exp.buffer));
    const data = JSON.parse(new TextDecoder().decode(files['data.json']));
    edit(data);
    files['data.json'] = strToU8(JSON.stringify(data));
    return Buffer.from(zipSync(files));
  }

  it('refuses to import into a semester that is in the trash', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [1]);
    const target = (await a.api('POST', '/api/semesters', { programId: h.program.id, title: 'SS 27' })).body;
    const zip = await tamperedPackage(a, h.course.id, () => {});
    const prev = await a.upload('/api/restore/preview', 'course.zip', zip);
    await a.api('DELETE', `/api/items/semester/${target.id}`);
    const imp = await a.api('POST', '/api/import/package', { token: prev.body.token, semesterId: target.id });
    expect(imp.status).toBe(400);
  });

  it('replaces unknown colours, icons, kinds and invalid schedules instead of storing them', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [2]);
    const zip = await tamperedPackage(a, h.course.id, (data) => {
      data.tables.courses[0].color = 'url(javascript:alert(1))';
      data.tables.courses[0].icon = 'skull';
      data.tables.courses[0].exam_date = 'next tuesday';
      data.tables.sections[0].kind = 'party';
      // Export order is not creation order, so pick the cards by their text.
      const c1 = data.tables.cards.find((c: { front: string }) => c.front === 'Q 1.1');
      const c2 = data.tables.cards.find((c: { front: string }) => c.front === 'Q 1.2');
      const base = { review_count: 1, lapse_count: 0, first_reviewed_at: '2026-10-01T08:00:00.000Z', last_reviewed_at: '2026-10-01T08:00:00.000Z', last_rating: 3, scheduler_version: 'recall-heuristic-v1', updated_at: '2026-10-01T08:00:00.000Z' };
      data.tables.card_schedules = [
        { ...base, card_id: c1.id, due_date: 'garbage', interval_days: 4 },
        { ...base, card_id: c2.id, due_date: '2026-10-20', interval_days: 4 },
      ];
    });
    const prev = await a.upload('/api/restore/preview', 'course.zip', zip);
    expect(prev.status).toBe(200);
    const imp = await a.api('POST', '/api/import/package', { token: prev.body.token, semesterId: h.semester.id, includeSchedules: true });
    expect(imp.status).toBe(201);

    const course = (await a.api('GET', `/api/courses/${imp.body.courseId}`)).body.item;
    expect(course.color).toBe('indigo');
    expect(course.icon).toBe('book-open');
    expect(course.examDate).toBeNull();
    const tree = (await a.api('GET', '/api/tree')).body;
    const sections = tree[0].semesters[0].courses.find((c: { id: string }) => c.id === imp.body.courseId).sections;
    expect(sections[0].kind).toBe('lecture');

    const cards = (await a.api('GET', `/api/cards?courseId=${imp.body.courseId}`)).body.cards as { front: string; schedule: { dueDate: string } | null }[];
    const byFront = new Map(cards.map((c) => [c.front, c]));
    expect(byFront.get('Q 1.1')?.schedule).toBeNull(); // invalid schedule dropped: the card stays new
    expect(byFront.get('Q 1.2')?.schedule?.dueDate).toBe('2026-10-20');
  });
});
