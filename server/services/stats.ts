import { addDays, dateRange, diffDays, isLocalDate, localDateOf, startOfLocalDay } from '../../shared/dates.ts';
import type { Rating, StudyMode } from '../../shared/ratings.ts';
import type { DashboardData, ModeStats, StatsData, StatsQuery } from '../../shared/types.ts';
import type { Ctx } from '../context.ts';
import { badRequest } from '../lib/util.ts';
import { getTree, resolveCurrentSemester, sectionCounts } from './hierarchy.ts';
import { toSemester } from './mappers.ts';
import { getOpenSession, listSessions } from './sessions.ts';
import { getSettings } from './settings.ts';
import { today } from './time.ts';

interface EventRow {
  session_id: string;
  card_id: string;
  section_id: string;
  mode: StudyMode;
  rating: Rating;
  rated_at: string;
  attempt_index: number;
  is_first_attempt: number;
  active_ms: number;
}

function scopeWhere(q: Pick<StatsQuery, 'programId' | 'semesterId' | 'courseId'>): { sql: string; params: string[] } {
  if (q.courseId) return { sql: 'AND c.course_id = ?', params: [q.courseId] };
  if (q.semesterId) return { sql: 'AND c.semester_id = ?', params: [q.semesterId] };
  if (q.programId) return { sql: 'AND c.program_id = ?', params: [q.programId] };
  return { sql: '', params: [] };
}

function loadEvents(ctx: Ctx, fromUtc: string, toUtc: string, q: StatsQuery): EventRow[] {
  const w = scopeWhere(q);
  return ctx.db
    .prepare(
      `SELECT re.session_id, re.card_id, c.section_id, re.mode, re.rating, re.rated_at, re.attempt_index, re.is_first_attempt, re.active_ms
       FROM review_events re JOIN card_ctx c ON c.id = re.card_id
       WHERE re.undone_at IS NULL AND re.rated_at >= ? AND re.rated_at < ? ${w.sql}
       ORDER BY re.rated_at`,
    )
    .all(fromUtc, toUtc, ...w.params) as EventRow[];
}

function zeroRatings(): Record<Rating, number> {
  return { 1: 0, 2: 0, 3: 0, 4: 0 };
}

function modeStats(events: EventRow[]): ModeStats {
  const first = events.filter((e) => e.is_first_attempt === 1);
  const firstRatingCounts = zeroRatings();
  for (const e of first) firstRatingCounts[e.rating]++;
  // Final rating per (session, card) = rating of its latest attempt.
  const finals = new Map<string, EventRow>();
  for (const e of events) {
    const k = `${e.session_id}|${e.card_id}`;
    const prev = finals.get(k);
    if (!prev || prev.attempt_index < e.attempt_index) finals.set(k, e);
  }
  let finished = 0;
  for (const e of finals.values()) if (e.rating >= 3) finished++;
  return {
    attempts: events.length,
    uniqueCards: new Set(events.map((e) => e.card_id)).size,
    firstAttempts: first.length,
    firstRatingCounts,
    finishedAfterRepeats: { finished, attemptedCards: finals.size },
  };
}

function streaks(dates: Set<string>, todayDate: string): { current: number; longest: number } {
  let current = 0;
  let cursor = dates.has(todayDate) ? todayDate : addDays(todayDate, -1);
  while (dates.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }
  const sorted = [...dates].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    run = prev && diffDays(prev, d) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { current, longest };
}

export function getStats(ctx: Ctx, input: Partial<StatsQuery>): StatsData {
  const settings = getSettings(ctx);
  const tz = settings.timeZone;
  const day = today(ctx);
  const to = input.to && isLocalDate(input.to) ? input.to : day;
  const from = input.from && isLocalDate(input.from) ? input.from : addDays(to, -29);
  if (from > to) throw badRequest('The start date must be before the end date');
  if (diffDays(from, to) > 3660) throw badRequest('Choose a range of at most ten years');
  const q: StatsQuery = { from, to, programId: input.programId || undefined, semesterId: input.semesterId || undefined, courseId: input.courseId || undefined };

  const events = loadEvents(ctx, startOfLocalDay(from, tz).toISOString(), startOfLocalDay(addDays(to, 1), tz).toISOString(), q);
  const byDay = new Map<string, { scheduled: number; practice: number; test: number; cards: Set<string>; activeMs: number }>();
  for (const d of dateRange(from, to)) byDay.set(d, { scheduled: 0, practice: 0, test: 0, cards: new Set(), activeMs: 0 });
  for (const e of events) {
    const d = localDateOf(e.rated_at, tz);
    const b = byDay.get(d);
    if (!b) continue;
    b[e.mode]++;
    b.cards.add(e.card_id);
    b.activeMs += e.active_ms;
  }
  const days = [...byDay.entries()].map(([date, b]) => ({
    date,
    scheduled: b.scheduled,
    practice: b.practice,
    test: b.test,
    uniqueCards: b.cards.size,
    activeMs: b.activeMs,
  }));

  // Weak sections: share of first attempts rated Bad/Good in the range.
  const sec = new Map<string, { weak: number; first: number }>();
  for (const e of events) {
    if (e.is_first_attempt !== 1) continue;
    const s = sec.get(e.section_id) ?? { weak: 0, first: 0 };
    s.first++;
    if (e.rating <= 2) s.weak++;
    sec.set(e.section_id, s);
  }
  const titleStmt = ctx.db.prepare(
    'SELECT s.title AS section_title, c.title AS course_title FROM sections s JOIN courses c ON c.id = s.course_id WHERE s.id = ?',
  );
  const weakSections = [...sec.entries()]
    .filter(([, v]) => v.weak > 0)
    .map(([sectionId, v]) => {
      const t = titleStmt.get(sectionId) as { section_title: string; course_title: string } | undefined;
      return { sectionId, sectionTitle: t?.section_title ?? 'Unknown section', courseTitle: t?.course_title ?? '', weakFirst: v.weak, firstAttempts: v.first };
    })
    .sort((a, b) => b.weakFirst / b.firstAttempts - a.weakFirst / a.firstAttempts || b.firstAttempts - a.firstAttempts)
    .slice(0, 8);

  // Heatmap and streaks use the full history in this scope, independent of the range.
  const w = scopeWhere(q);
  const allDates = ctx.db
    .prepare(
      `SELECT re.rated_at FROM review_events re JOIN card_ctx c ON c.id = re.card_id WHERE re.undone_at IS NULL ${w.sql}`,
    )
    .all(...w.params) as { rated_at: string }[];
  const perDate = new Map<string, number>();
  for (const r of allDates) {
    const d = localDateOf(r.rated_at, tz);
    perDate.set(d, (perDate.get(d) ?? 0) + 1);
  }
  const heatFrom = addDays(day, -181);
  const heatmap = dateRange(heatFrom, day).map((date) => ({ date, attempts: perDate.get(date) ?? 0 }));

  // Current card state in scope (visible cards only).
  const cur = ctx.db
    .prepare(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN c.suspended_at IS NULL AND cs.card_id IS NULL THEN 1 ELSE 0 END) AS new,
        SUM(CASE WHEN c.suspended_at IS NULL AND cs.due_date <= ? THEN 1 ELSE 0 END) AS due,
        SUM(CASE WHEN c.suspended_at IS NOT NULL THEN 1 ELSE 0 END) AS suspended,
        SUM(CASE WHEN cs.card_id IS NOT NULL THEN 1 ELSE 0 END) AS reviewed
       FROM card_ctx c LEFT JOIN card_schedules cs ON cs.card_id = c.id
       WHERE c.in_trash = 0 AND c.in_archive = 0 ${w.sql}`,
    )
    .get(day, ...w.params) as { total: number; new: number | null; due: number | null; suspended: number | null; reviewed: number | null };

  const byMode = {
    scheduled: modeStats(events.filter((e) => e.mode === 'scheduled')),
    practice: modeStats(events.filter((e) => e.mode === 'practice')),
    test: modeStats(events.filter((e) => e.mode === 'test')),
  };

  return {
    query: q,
    timeZone: tz,
    today: day,
    scopeLabel: scopeLabelFor(ctx, q),
    current: {
      due: cur.due ?? 0,
      new: cur.new ?? 0,
      total: cur.total,
      suspended: cur.suspended ?? 0,
      reviewedEver: cur.reviewed ?? 0,
    },
    days,
    totals: {
      attempts: events.length,
      uniqueCards: new Set(events.map((e) => e.card_id)).size,
      activeMs: events.reduce((n, e) => n + e.active_ms, 0),
      sessions: new Set(events.map((e) => e.session_id)).size,
      studyDays: days.filter((d) => d.scheduled + d.practice + d.test > 0).length,
    },
    byMode,
    weakSections,
    heatmap,
    streak: streaks(new Set(perDate.keys()), day),
    recentSessions: listSessions(ctx, 8),
  };
}

function scopeLabelFor(ctx: Ctx, q: StatsQuery): string {
  const one = (sql: string, id: string) => (ctx.db.prepare(sql).get(id) as { title: string } | undefined)?.title;
  if (q.courseId) return one('SELECT title FROM courses WHERE id = ?', q.courseId) ?? 'Unknown course';
  if (q.semesterId) return one('SELECT title FROM semesters WHERE id = ?', q.semesterId) ?? 'Unknown semester';
  if (q.programId) return one('SELECT title FROM programs WHERE id = ?', q.programId) ?? 'Unknown program';
  return 'All programs';
}

export function getDashboard(ctx: Ctx): DashboardData {
  const settings = getSettings(ctx);
  const tz = settings.timeZone;
  const day = today(ctx);
  const tree = getTree(ctx);
  const sem = resolveCurrentSemester(ctx);
  const courses: DashboardData['courses'] = [];
  for (const p of tree) {
    for (const s of p.semesters) {
      if (sem && s.id !== sem.id) continue;
      for (const c of s.courses) courses.push({ ...c, programTitle: p.title, semesterTitle: s.title });
    }
  }
  const counts = { due: 0, new: 0, total: 0 };
  for (const c of courses) {
    counts.due += c.counts.due;
    counts.new += c.counts.new;
    counts.total += c.counts.total;
  }

  // Recently active sections: latest card edit or review.
  const recent = ctx.db
    .prepare(
      `SELECT s.id, s.title, s.course_id, co.title AS course_title, co.color AS course_color,
         MAX(COALESCE((SELECT MAX(re.rated_at) FROM review_events re JOIN cards c2 ON c2.id = re.card_id WHERE c2.section_id = s.id AND re.undone_at IS NULL), ''),
             COALESCE((SELECT MAX(c3.updated_at) FROM cards c3 WHERE c3.section_id = s.id AND c3.deleted_at IS NULL), ''),
             s.updated_at) AS last_activity
       FROM section_ctx s JOIN courses co ON co.id = s.course_id
       WHERE s.in_trash = 0 AND s.in_archive = 0
       ORDER BY last_activity DESC LIMIT 6`,
    )
    .all() as { id: string; title: string; course_id: string; course_title: string; course_color: string; last_activity: string }[];
  const rc = sectionCounts(ctx, recent.map((r) => r.id));

  const from = addDays(day, -13);
  const evs = ctx.db
    .prepare('SELECT card_id, rated_at FROM review_events WHERE undone_at IS NULL AND rated_at >= ?')
    .all(startOfLocalDay(from, tz).toISOString()) as { card_id: string; rated_at: string }[];
  const act = new Map<string, { attempts: number; cards: Set<string> }>();
  for (const d of dateRange(from, day)) act.set(d, { attempts: 0, cards: new Set() });
  for (const e of evs) {
    const b = act.get(localDateOf(e.rated_at, tz));
    if (b) {
      b.attempts++;
      b.cards.add(e.card_id);
    }
  }
  const hasContent = (ctx.db.prepare('SELECT COUNT(*) AS n FROM programs WHERE deleted_at IS NULL').get() as { n: number }).n > 0;
  const demoLoaded = (ctx.db.prepare('SELECT COUNT(*) AS n FROM programs WHERE is_demo = 1').get() as { n: number }).n > 0;
  return {
    settings,
    today: day,
    hasContent,
    currentSemester: sem ? { ...toSemester(sem), programTitle: sem.program_title } : null,
    counts,
    openSession: getOpenSession(ctx),
    courses,
    recentSections: recent.map((r) => ({
      id: r.id,
      title: r.title,
      courseId: r.course_id,
      courseTitle: r.course_title,
      courseColor: r.course_color,
      lastActivityAt: r.last_activity,
      counts: rc.get(r.id) ?? { total: 0, due: 0, new: 0, suspended: 0 },
    })),
    activity: [...act.entries()].map(([date, b]) => ({ date, attempts: b.attempts, uniqueCards: b.cards.size })),
    demoLoaded,
  };
}
