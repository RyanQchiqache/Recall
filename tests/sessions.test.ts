import { afterEach, describe, expect, it } from 'vitest';
import { key, makeApp, makeClock, revealAndRate, seedHierarchy, sessionRequest, type TestApp } from './helpers.ts';

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

function dbRows(a: TestApp, sessionId: string, cardId: string) {
  const db = a.ctx.db;
  return {
    session: db.prepare('SELECT attempt_counter, next_queue_order, current_card_id, revealed, relaxed, status, is_open FROM study_sessions WHERE id = ?').get(sessionId),
    cards: db.prepare('SELECT card_id, queue_order, eligible_after, attempts, status, first_rating, final_rating FROM session_cards WHERE session_id = ? ORDER BY card_id').all(sessionId),
    schedule: db.prepare('SELECT * FROM card_schedules WHERE card_id = ?').get(cardId) ?? null,
    events: (db.prepare('SELECT COUNT(*) AS n FROM review_events WHERE session_id = ? AND undone_at IS NULL').get(sessionId) as { n: number }).n,
  };
}

describe('session selection', () => {
  it('selects 30 / 40 unique cards from multiple sections without exceeding eligibility', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [15, 15, 15]);
    const sectionIds = h.sections.map((s) => s.id);
    for (const size of [30, 40]) {
      const res = await a.api('POST', '/api/sessions', sessionRequest({ sectionIds }, { size, ordering: 'random', mode: 'practice' }));
      expect(res.status).toBe(201);
      const ids = (a.ctx.db.prepare('SELECT card_id FROM session_cards WHERE session_id = ?').all(res.body.id) as { card_id: string }[]).map((r) => r.card_id);
      expect(ids).toHaveLength(size);
      expect(new Set(ids).size).toBe(size);
      const all = new Set(h.sections.flatMap((s) => s.cardIds));
      expect(ids.every((id) => all.has(id))).toBe(true);
      await a.api('POST', `/api/sessions/${res.body.id}/end`);
    }
  });

  it('reports a smaller pool and starts only after explicit acceptance; never duplicates', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [10, 8]);
    const req = sessionRequest({ courseIds: [h.course.id] }, { size: 30 });
    const preview = await a.api('POST', '/api/sessions/preview', req);
    expect(preview.body).toMatchObject({ available: 18, willSelect: 18, requested: 30 });
    const refused = await a.api('POST', '/api/sessions', req);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe('18 cards available');
    const ok = await a.api('POST', '/api/sessions', { ...req, acceptSmaller: true });
    expect(ok.status).toBe(201);
    expect(ok.body.progress.selected).toBe(18);
  });

  it('rejects an empty scope and an empty pool', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [0]);
    expect((await a.api('POST', '/api/sessions', sessionRequest({}))).status).toBe(400);
    const empty = await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }));
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('empty_selection');
  });

  it('keeps archived, suspended and deleted cards out of new sessions', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [3, 3, 3]);
    const [s1, s2, s3] = h.sections;
    await a.api('PATCH', `/api/cards/${s1.cardIds[0]}`, { suspended: true });
    await a.api('DELETE', `/api/items/card/${s1.cardIds[1]}`);
    await a.api('PATCH', `/api/sections/${s2.id}`, { archived: true });
    await a.api('DELETE', `/api/items/section/${s3.id}`);
    const preview = await a.api('POST', '/api/sessions/preview', sessionRequest({ courseIds: [h.course.id] }, { mode: 'practice' }));
    expect(preview.body.available).toBe(1);
    expect(preview.body.breakdown.suspended).toBe(1);
    // Archiving the whole course hides it too.
    await a.api('PATCH', `/api/courses/${h.course.id}`, { archived: true });
    const p2 = await a.api('POST', '/api/sessions/preview', sessionRequest({ courseIds: [h.course.id] }, { mode: 'practice' }));
    expect(p2.body.available).toBe(0);
  });

  it('orders scheduled review oldest-due first, then new cards, ties by ID', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [4]);
    const [c1, c2, c3, c4] = h.sections[0].cardIds;
    const ins = a.ctx.db.prepare(
      `INSERT INTO card_schedules (card_id, due_date, interval_days, review_count, lapse_count, first_reviewed_at, last_reviewed_at, last_rating, scheduler_version, updated_at)
       VALUES (?, ?, 3, 1, 0, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 3, 'recall-heuristic-v1', '2026-10-01T00:00:00Z')`,
    );
    ins.run(c3, '2026-10-10');
    ins.run(c2, '2026-10-12');
    ins.run(c4, '2026-12-01'); // not yet due
    const s = await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { acceptSmaller: true }));
    const order = (a.ctx.db.prepare('SELECT card_id FROM session_cards WHERE session_id = ? ORDER BY initial_position').all(s.body.id) as { card_id: string }[]).map((r) => r.card_id);
    expect(order).toEqual([c3, c2, c1]);
    const without = await a.api('POST', '/api/sessions/preview', sessionRequest({ sectionIds: [h.sections[0].id] }, { filters: { includeNew: false, tags: [], bookmarkedOnly: false, status: 'any', weakBasis: 'all' } }));
    expect(without.body).toMatchObject({ available: 2, breakdown: { due: 2, new: 1, notYetDue: 1 } });
  });

  it('persists random order so a reload never reshuffles', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [20]);
    const s = await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { size: 10, ordering: 'random', mode: 'practice' }));
    const first = (await a.api('GET', `/api/sessions/${s.body.id}`)).body.current.cardId;
    const again = (await a.api('GET', `/api/sessions/${s.body.id}`)).body.current.cardId;
    expect(again).toBe(first);
    expect(typeof (a.ctx.db.prepare('SELECT seed FROM study_sessions WHERE id = ?').get(s.body.id) as { seed: number }).seed).toBe('number');
  });
});

describe('scheduling through sessions', () => {
  it('caps reviews before an upcoming course exam and leaves other courses unchanged', async () => {
    const a = await app();
    const withExam = await seedHierarchy(a, [1]);
    await a.api('PATCH', `/api/courses/${withExam.course.id}`, { examDate: '2026-10-18' });
    const examSession = (await a.api('POST', '/api/sessions', sessionRequest({ courseIds: [withExam.course.id] }, { size: 1 }))).body;
    const examRating = await revealAndRate(a, examSession.id, 4);
    expect((await a.api('GET', `/api/cards/${examRating.cardId}`)).body.card.schedule.dueDate).toBe('2026-10-17');

    const withoutExam = await seedHierarchy(a, [1]);
    const normalSession = (await a.api('POST', '/api/sessions', sessionRequest({ courseIds: [withoutExam.course.id] }, { size: 1 }))).body;
    const normalRating = await revealAndRate(a, normalSession.id, 4);
    expect((await a.api('GET', `/api/cards/${normalRating.cardId}`)).body.card.schedule.dueDate).toBe('2026-10-20');
  });

  it('new card rated Bad then Perfect stays due in one day; first Bad, final Perfect', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [1]);
    const cardId = h.sections[0].cardIds[0];
    const s = (await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { acceptSmaller: true }))).body;
    await revealAndRate(a, s.id, 1);
    let st = (await a.api('GET', `/api/sessions/${s.id}`)).body;
    expect(st.waiting).toBe(true); // one-card session → explicit relaxation
    st = (await a.api('POST', `/api/sessions/${s.id}/relax`, { revision: st.revision })).body;
    expect(st.current.cardId).toBe(cardId);
    await revealAndRate(a, s.id, 4);
    const sched = (await a.api('GET', `/api/cards/${cardId}`)).body.card.schedule;
    expect(sched).toMatchObject({ dueDate: '2026-10-14', intervalDays: 1, lastRating: 1, reviewCount: 1, lapseCount: 0 });
    const results = (await a.api('GET', `/api/sessions/${s.id}/results`)).body;
    expect(results.session.status).toBe('completed');
    expect(results.cards[0]).toMatchObject({ firstRating: 1, finalRating: 4, attempts: 2, status: 'completed' });
    expect(results.weakCardIds).toEqual([cardId]);
  });

  it('gives 1/12/20/30 days for a reviewed card with interval 10; practice leaves it unchanged', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [4]);
    const ids = h.sections[0].cardIds;
    const ins = a.ctx.db.prepare(
      `INSERT INTO card_schedules (card_id, due_date, interval_days, review_count, lapse_count, first_reviewed_at, last_reviewed_at, last_rating, scheduler_version, updated_at)
       VALUES (?, '2026-10-13', 10, 2, 0, '2026-09-01T00:00:00Z', '2026-10-03T00:00:00Z', 3, 'recall-heuristic-v1', '2026-10-03T00:00:00Z')`,
    );
    for (const id of ids) ins.run(id);
    // Practice first: must not change anything.
    const p = (await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { mode: 'practice', size: 4 }))).body;
    for (let i = 0; i < 4; i++) await revealAndRate(a, p.id, 4);
    for (const id of ids) expect((await a.api('GET', `/api/cards/${id}`)).body.card.schedule).toMatchObject({ intervalDays: 10, dueDate: '2026-10-13' });

    const s = (await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { size: 4 }))).body;
    const got: Record<number, number> = {};
    for (const rating of [3, 4, 2, 1]) {
      // Rate so that Bad/Good come last and are not re-shown before we check.
      const { cardId } = await revealAndRate(a, s.id, rating);
      got[rating] = (await a.api('GET', `/api/cards/${cardId}`)).body.card.schedule.intervalDays;
    }
    expect(got).toEqual({ 1: 1, 2: 12, 3: 20, 4: 30 });
    const lapses = a.ctx.db.prepare('SELECT SUM(lapse_count) AS n FROM card_schedules').get() as { n: number };
    expect(lapses.n).toBe(1);
  });

  it('only the first rating per scheduled session changes the schedule', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [3]);
    const s = (await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { size: 3 }))).body;
    const { cardId } = await revealAndRate(a, s.id, 2); // Good → 2 days
    await revealAndRate(a, s.id, 3);
    await revealAndRate(a, s.id, 3);
    let st = (await a.api('GET', `/api/sessions/${s.id}`)).body;
    if (st.waiting) st = (await a.api('POST', `/api/sessions/${s.id}/relax`, { revision: st.revision })).body;
    expect(st.current.cardId).toBe(cardId);
    await revealAndRate(a, s.id, 4); // repeat Perfect must not multiply
    expect((await a.api('GET', `/api/cards/${cardId}`)).body.card.schedule).toMatchObject({ intervalDays: 2, dueDate: '2026-10-15', reviewCount: 1 });
    const evs = a.ctx.db.prepare('SELECT affects_schedule, is_first_attempt FROM review_events WHERE card_id = ? ORDER BY attempt_index').all(cardId);
    expect(evs).toEqual([{ affects_schedule: 1, is_first_attempt: 1 }, { affects_schedule: 0, is_first_attempt: 0 }]);
  });

  it('commits the first rating immediately even if the session is abandoned', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [3]);
    const s = (await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { size: 3 }))).body;
    const { cardId } = await revealAndRate(a, s.id, 3);
    await a.api('POST', `/api/sessions/${s.id}/end`);
    expect((await a.api('GET', `/api/cards/${cardId}`)).body.card.schedule.intervalDays).toBe(4);
    const r = (await a.api('GET', `/api/sessions/${s.id}/results`)).body;
    expect(r.session.status).toBe('ended');
    expect(r.notReached).toBe(2);
  });

  it('uses the session’s settings snapshot, so later settings changes apply to future sessions only', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [2]);
    const s = (await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { size: 2 }))).body;
    await a.api('PATCH', '/api/settings', { scheduler: { perfect: { base: 10, multiplier: 3 } } });
    const { cardId } = await revealAndRate(a, s.id, 4);
    expect((await a.api('GET', `/api/cards/${cardId}`)).body.card.schedule.intervalDays).toBe(7);
  });
});

describe('undo and idempotency', () => {
  it('undo restores queue, schedule, event count and progress exactly', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [4]);
    const s = (await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { size: 4 }))).body;
    await revealAndRate(a, s.id, 3);
    const before = (await a.api('GET', `/api/sessions/${s.id}`)).body;
    const cardId = before.current.cardId;
    const revealed = (await a.api('POST', `/api/sessions/${s.id}/reveal`, { revision: before.revision })).body;
    const rowsBefore = dbRows(a, s.id, cardId);
    const rated = await a.api('POST', `/api/sessions/${s.id}/rate`, { rating: 1, idempotencyKey: key(), revision: revealed.revision });
    expect(rated.status).toBe(200);
    expect(dbRows(a, s.id, cardId)).not.toEqual(rowsBefore);
    const undone = await a.api('POST', `/api/sessions/${s.id}/undo`, { revision: rated.body.state.revision });
    expect(undone.status).toBe(200);
    expect(dbRows(a, s.id, cardId)).toEqual(rowsBefore);
    expect(undone.body.progress).toEqual(revealed.progress);
    expect(undone.body.current.cardId).toBe(cardId);
    expect(undone.body.revealed).toBe(true);
    // The undone event is kept for audit but marked.
    expect((a.ctx.db.prepare('SELECT COUNT(*) AS n FROM review_events WHERE undone_at IS NOT NULL').get() as { n: number }).n).toBe(1);
  });

  it('undo of a completing rating reopens the session', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [1]);
    const s = (await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { size: 1 }))).body;
    const { state } = await revealAndRate(a, s.id, 4);
    expect(state.status).toBe('completed');
    const u = await a.api('POST', `/api/sessions/${s.id}/undo`, { revision: state.revision });
    expect(u.body.status).toBe('active');
    expect((await a.api('GET', '/api/sessions/open')).body.id).toBe(s.id);
    expect((await a.api('GET', `/api/cards/${h.sections[0].cardIds[0]}`)).body.card.schedule).toBeNull();
  });

  it('rating twice quickly with the same key creates one accepted attempt', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [3]);
    const s = (await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { size: 3 }))).body;
    const r = (await a.api('POST', `/api/sessions/${s.id}/reveal`, { revision: s.revision })).body;
    const k = key();
    const [x, y] = await Promise.all([
      a.api('POST', `/api/sessions/${s.id}/rate`, { rating: 3, idempotencyKey: k, revision: r.revision }),
      a.api('POST', `/api/sessions/${s.id}/rate`, { rating: 3, idempotencyKey: k, revision: r.revision }),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect([x.body.replayed, y.body.replayed].sort()).toEqual([false, true]);
    expect((a.ctx.db.prepare('SELECT COUNT(*) AS n FROM review_events').get() as { n: number }).n).toBe(1);
    expect(y.body.state.progress.totalAttempts).toBe(1);
  });

  it('a stale tab (old revision) cannot rate a different card', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [3]);
    const s = (await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { size: 3 }))).body;
    const tabA = (await a.api('POST', `/api/sessions/${s.id}/reveal`, { revision: s.revision })).body;
    const tabB = (await a.api('GET', `/api/sessions/${s.id}`)).body;
    await a.api('POST', `/api/sessions/${s.id}/rate`, { rating: 3, idempotencyKey: key(), revision: tabA.revision });
    const stale = await a.api('POST', `/api/sessions/${s.id}/rate`, { rating: 1, idempotencyKey: key(), revision: tabB.revision });
    expect(stale.status).toBe(409);
    expect((a.ctx.db.prepare('SELECT COUNT(*) AS n FROM review_events').get() as { n: number }).n).toBe(1);
  });

  it('allows only one open session; rating requires reveal', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [3]);
    const s = (await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { size: 3 }))).body;
    const second = await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { size: 3 }));
    expect(second.status).toBe(409);
    expect(second.body.error.details.sessionId).toBe(s.id);
    const early = await a.api('POST', `/api/sessions/${s.id}/rate`, { rating: 3, idempotencyKey: key(), revision: s.revision });
    expect(early.status).toBe(400);
  });

  it('blocks deleting cards used by the open session', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [2]);
    await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { size: 2 }));
    const del = await a.api('DELETE', `/api/items/card/${h.sections[0].cardIds[0]}`);
    expect(del.status).toBe(409);
    const delCourse = await a.api('DELETE', `/api/items/course/${h.course.id}`);
    expect(delCourse.status).toBe(409);
  });
});

describe('persistence across restarts', () => {
  it('resumes the same card, order and revealed state after a server restart', async () => {
    const clock = makeClock();
    const a = await makeApp({ clock });
    const h = await seedHierarchy(a, [12]);
    const s = (await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { size: 10, ordering: 'random', mode: 'practice' }))).body;
    await revealAndRate(a, s.id, 1);
    await revealAndRate(a, s.id, 3);
    const mid = (await a.api('GET', `/api/sessions/${s.id}`)).body;
    await a.api('POST', `/api/sessions/${s.id}/reveal`, { revision: mid.revision });
    const before = (await a.api('GET', `/api/sessions/${s.id}`)).body;
    const order = a.ctx.db.prepare('SELECT card_id, initial_position, queue_order FROM session_cards WHERE session_id = ? ORDER BY initial_position').all(s.id);
    await a.close();

    const b = await makeApp({ dataDir: a.dataDir, clock });
    apps.push(b);
    const after = (await b.api('GET', `/api/sessions/${s.id}`)).body;
    expect(after.current.cardId).toBe(before.current.cardId);
    expect(after.revealed).toBe(true);
    expect(after.progress).toEqual(before.progress);
    expect(b.ctx.db.prepare('SELECT card_id, initial_position, queue_order FROM session_cards WHERE session_id = ? ORDER BY initial_position').all(s.id)).toEqual(order);
  });

  it('pauses without counting paused time and caps idle gaps', async () => {
    const a = await app();
    const h = await seedHierarchy(a, [3]);
    const s = (await a.api('POST', '/api/sessions', sessionRequest({ sectionIds: [h.sections[0].id] }, { size: 3 }))).body;
    a.clock.advance(30_000);
    await a.api('POST', `/api/sessions/${s.id}/pause`);
    a.clock.advance(60 * 60_000); // an hour paused
    const resumed = (await a.api('POST', `/api/sessions/${s.id}/resume`)).body;
    expect(resumed.activeMs).toBe(30_000);
    a.clock.advance(5_000);
    const r = (await a.api('POST', `/api/sessions/${s.id}/reveal`, { revision: resumed.revision })).body;
    expect(r.activeMs).toBe(35_000);
    a.clock.advance(3 * 60 * 60_000); // walked away without pausing
    const rated = (await a.api('POST', `/api/sessions/${s.id}/rate`, { rating: 3, idempotencyKey: key(), revision: r.revision })).body;
    expect(rated.state.activeMs).toBe(35_000 + 10 * 60_000);
  });
});
