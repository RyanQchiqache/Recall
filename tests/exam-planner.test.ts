import { afterEach, describe, expect, it } from 'vitest';
import { buildExamWorkload } from '../shared/exam-planner.ts';
import { makeApp, makeClock, seedHierarchy, type TestApp } from './helpers.ts';

let apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.close();
  apps = [];
});

describe('seven-day exam workload', () => {
  it('spreads new cards with the same buffer rule and caps reviews before the exam', () => {
    const plan = buildExamWorkload({
      today: '2026-10-13',
      examDate: '2026-10-20',
      newCards: 10,
      dueDates: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-20', '2026-10-25'],
    });

    expect(plan.bufferDays).toBe(3);
    expect(plan.days.map((day) => day.date)).toEqual([
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
      '2026-10-19',
    ]);
    expect(plan.days.map((day) => day.learn)).toEqual([3, 3, 2, 2, 0, 0, 0]);
    expect(plan.days.map((day) => day.revise)).toEqual([2, 1, 0, 0, 0, 0, 2]);
  });

  it('uses the first preview day as the dashboard daily plan', async () => {
    const app = await makeApp({ clock: makeClock('2026-10-13T08:00:00.000Z') });
    apps.push(app);
    const hierarchy = await seedHierarchy(app, [10]);
    const [dueToday, dueAfterExam] = hierarchy.sections[0].cardIds;
    const insert = app.ctx.db.prepare(
      `INSERT INTO card_schedules
       (card_id, due_date, interval_days, review_count, lapse_count, first_reviewed_at, last_reviewed_at,
        last_rating, scheduler_version, updated_at)
       VALUES (?, ?, 4, 1, 0, ?, ?, 3, 'recall-heuristic-v1', ?)`,
    );
    const timestamp = '2026-10-10T08:00:00.000Z';
    insert.run(dueToday, '2026-10-13', timestamp, timestamp, timestamp);
    insert.run(dueAfterExam, '2026-11-01', timestamp, timestamp, timestamp);
    await app.api('PATCH', `/api/courses/${hierarchy.course.id}`, { examDate: '2026-10-20' });

    const cappedSchedule = app.ctx.db
      .prepare('SELECT due_date FROM card_schedules WHERE card_id = ?')
      .get(dueAfterExam) as { due_date: string };
    expect(cappedSchedule.due_date).toBe('2026-10-19');

    const dashboard = (await app.api('GET', '/api/dashboard')).body;
    const course = dashboard.courses.find((item: { id: string }) => item.id === hierarchy.course.id);
    expect(course.examPlan.learnToday).toBe(course.examPlan.days[0].learn);
    expect(course.examPlan.reviseToday).toBe(course.examPlan.days[0].revise);
    expect(course.examPlan).toMatchObject({ learnToday: 2, reviseToday: 1 });
    expect(course.examPlan.days.at(-1)).toMatchObject({ date: '2026-10-19', revise: 1 });
  });
});
