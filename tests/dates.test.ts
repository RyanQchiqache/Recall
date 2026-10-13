import { describe, expect, it } from 'vitest';
import { addDays, diffDays, isDue, isLocalDate, localDateOf, startOfLocalDay } from '../shared/dates.ts';

const TZ = 'Europe/Berlin';

describe('calendar dates in Europe/Berlin', () => {
  it('maps instants to local dates around midnight', () => {
    // CEST (UTC+2) in October before the switch.
    expect(localDateOf('2026-10-13T21:59:59Z', TZ)).toBe('2026-10-13');
    expect(localDateOf('2026-10-13T22:00:00Z', TZ)).toBe('2026-10-14');
    // CET (UTC+1) in winter.
    expect(localDateOf('2026-12-31T22:59:59Z', TZ)).toBe('2026-12-31');
    expect(localDateOf('2026-12-31T23:00:00Z', TZ)).toBe('2027-01-01');
  });

  it('finds the start of local days across the spring-forward transition (29 Mar 2026)', () => {
    expect(startOfLocalDay('2026-03-28', TZ).toISOString()).toBe('2026-03-27T23:00:00.000Z');
    expect(startOfLocalDay('2026-03-29', TZ).toISOString()).toBe('2026-03-28T23:00:00.000Z');
    // The 29th is only 23 hours long, so the 30th starts at 22:00 UTC.
    expect(startOfLocalDay('2026-03-30', TZ).toISOString()).toBe('2026-03-29T22:00:00.000Z');
  });

  it('finds the start of local days across the fall-back transition (25 Oct 2026)', () => {
    expect(startOfLocalDay('2026-10-25', TZ).toISOString()).toBe('2026-10-24T22:00:00.000Z');
    // The 25th is 25 hours long, so the 26th starts at 23:00 UTC.
    expect(startOfLocalDay('2026-10-26', TZ).toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('adds calendar days, not 24-hour blocks', () => {
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(diffDays('2026-03-28', '2026-03-30')).toBe(2);
    expect(diffDays('2026-10-24', '2026-10-26')).toBe(2);
  });

  it('makes a card due exactly at local midnight of its due date', () => {
    // Due 2026-10-26 (after fall-back) → due from 2026-10-25T23:00Z.
    expect(isDue('2026-10-26', new Date('2026-10-25T22:59:59Z'), TZ)).toBe(false);
    expect(isDue('2026-10-26', new Date('2026-10-25T23:00:00Z'), TZ)).toBe(true);
    // Due 2026-03-30 (after spring-forward) → due from 2026-03-29T22:00Z.
    expect(isDue('2026-03-30', new Date('2026-03-29T21:59:59Z'), TZ)).toBe(false);
    expect(isDue('2026-03-30', new Date('2026-03-29T22:00:00Z'), TZ)).toBe(true);
  });

  it('handles a zone whose midnight can be skipped', () => {
    // America/Santiago skips 00:00 → 01:00 on DST start (2026-09-06).
    const start = startOfLocalDay('2026-09-06', 'America/Santiago');
    expect(localDateOf(start, 'America/Santiago')).toBe('2026-09-06');
    expect(localDateOf(new Date(start.getTime() - 1000), 'America/Santiago')).toBe('2026-09-05');
  });

  it('validates calendar dates', () => {
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2028-02-29')).toBe(true);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('26-1-1')).toBe(false);
  });
});
