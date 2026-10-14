import { describe, expect, it } from 'vitest';
import type { Rating } from '../shared/ratings.ts';
import { DEFAULT_SCHEDULER_SETTINGS, heuristicV1, nextIntervalDays, normalizeSchedulerSettings, type ScheduleState } from '../shared/scheduler.ts';

const TZ = 'Europe/Berlin';
const S = DEFAULT_SCHEDULER_SETTINGS;

function reviewed(intervalDays: number, lapseCount = 0): ScheduleState {
  return {
    dueDate: '2026-10-13',
    intervalDays,
    reviewCount: 3,
    lapseCount,
    firstReviewedAt: '2026-09-01T10:00:00.000Z',
    lastReviewedAt: '2026-10-03T10:00:00.000Z',
    lastRating: 3,
    schedulerVersion: 'recall-heuristic-v1',
  };
}

describe('recall-heuristic-v1 intervals', () => {
  it('uses the new-card table', () => {
    expect([1, 2, 3, 4].map((r) => nextIntervalDays(null, r as Rating))).toEqual([1, 2, 4, 7]);
  });

  it('gives 1/12/20/30 days for a previously reviewed card with I = 10', () => {
    expect([1, 2, 3, 4].map((r) => nextIntervalDays(10, r as Rating))).toEqual([1, 12, 20, 30]);
  });

  it('applies minimums for short previous intervals', () => {
    expect(nextIntervalDays(1, 2)).toBe(2); // max(2, ceil(1.2))
    expect(nextIntervalDays(1, 3)).toBe(4); // max(4, 2)
    expect(nextIntervalDays(2, 4)).toBe(7); // max(7, 6)
    expect(nextIntervalDays(3, 2)).toBe(4); // ceil(3.6)
  });

  it('is immune to floating point noise in ceil', () => {
    // 10 × 1.2 and 5 × 1.2 must not round up past the exact value.
    expect(nextIntervalDays(5, 2)).toBe(6);
    expect(nextIntervalDays(15, 2)).toBe(18);
    expect(nextIntervalDays(25, 2)).toBe(30);
  });

  it('caps at 365 days by default and respects a configured cap', () => {
    expect(nextIntervalDays(200, 4)).toBe(365);
    expect(nextIntervalDays(200, 4, { ...S, maxIntervalDays: 90 })).toBe(90);
  });

  it('computes due dates on the local calendar and counts lapses', () => {
    const at = new Date('2026-10-13T08:00:00Z');
    const first = heuristicV1.next({ previous: null, rating: 1, reviewedAt: at, timeZone: TZ, settings: S });
    expect(first).toMatchObject({ dueDate: '2026-10-14', intervalDays: 1, reviewCount: 1, lapseCount: 0, lastRating: 1 });
    // Bad on a previously reviewed card is a lapse.
    const lapse = heuristicV1.next({ previous: reviewed(10, 2), rating: 1, reviewedAt: at, timeZone: TZ, settings: S });
    expect(lapse).toMatchObject({ intervalDays: 1, dueDate: '2026-10-14', lapseCount: 3, reviewCount: 4 });
    const good = heuristicV1.next({ previous: reviewed(10, 2), rating: 2, reviewedAt: at, timeZone: TZ, settings: S });
    expect(good).toMatchObject({ intervalDays: 12, dueDate: '2026-10-25', lapseCount: 2 });
  });

  it('uses the review instant’s local date across daylight-saving changes', () => {
    // 00:30 local on 29 Mar 2026 (spring forward day) is still 28 Mar in UTC.
    const atSpring = new Date('2026-03-28T23:30:00Z');
    expect(heuristicV1.next({ previous: null, rating: 2, reviewedAt: atSpring, timeZone: TZ, settings: S }).dueDate).toBe('2026-03-31');
    // 23:30 local on 24 Oct (CEST) → 7 days later is 31 Oct even though one day has 25 hours.
    const atFall = new Date('2026-10-24T21:30:00Z');
    expect(heuristicV1.next({ previous: null, rating: 4, reviewedAt: atFall, timeZone: TZ, settings: S }).dueDate).toBe('2026-10-31');
  });

  it('caps a review at the day before an exam', () => {
    const at = new Date('2026-10-13T08:00:00Z');
    const capped = heuristicV1.next({ previous: reviewed(10), rating: 4, reviewedAt: at, timeZone: TZ, settings: S, maxDueDate: '2026-10-19' });
    expect(capped).toMatchObject({ dueDate: '2026-10-19', intervalDays: 30 });
  });

  it('keeps the normal interval when there is no exam cap', () => {
    const at = new Date('2026-10-13T08:00:00Z');
    expect(heuristicV1.next({ previous: reviewed(10), rating: 4, reviewedAt: at, timeZone: TZ, settings: S }).dueDate).toBe('2026-11-12');
  });

  it('normalizes invalid settings back to defaults', () => {
    const n = normalizeSchedulerSettings({ good: { base: -3, multiplier: 99 }, maxIntervalDays: 'x' });
    expect(n.good).toEqual(S.good);
    expect(n.maxIntervalDays).toBe(365);
    expect(n.bad.multiplier).toBeNull();
  });
});
