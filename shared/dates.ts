/**
 * Calendar-date helpers.
 *
 * Due dates are stored as local calendar dates (`YYYY-MM-DD`) in the configured
 * IANA timezone. Calendar arithmetic is done on the date itself, never by adding
 * multiples of 24 hours, so daylight-saving transitions cannot shift a due date.
 */

export type LocalDate = string; // YYYY-MM-DD

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function isLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(instant)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** The local calendar date of an instant in the given timezone. */
export function localDateOf(instant: Date | string | number, timeZone: string): LocalDate {
  const d = instant instanceof Date ? instant : new Date(instant);
  const p = zonedParts(d, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Offset (ms) of the timezone from UTC at an instant: local wall time minus UTC. */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - truncated;
}

function parse(date: LocalDate): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid calendar date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Add whole calendar days to a calendar date. */
export function addDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isInteger(days)) throw new Error('addDays requires a whole number of days');
  const [y, m, d] = parse(date);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Whole calendar days from `a` to `b` (b - a). */
export function diffDays(a: LocalDate, b: LocalDate): number {
  const [ay, am, ad] = parse(a);
  const [by, bm, bd] = parse(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The UTC instant at which a local calendar date begins in the timezone.
 * Handles zones whose midnight is skipped by DST (returns the first existing instant).
 */
export function startOfLocalDay(date: LocalDate, timeZone: string): Date {
  const [y, m, d] = parse(date);
  const wallMidnight = Date.UTC(y, m - 1, d, 0, 0, 0);
  // Two refinement passes are sufficient for every real-world offset change.
  let guess = wallMidnight - timeZoneOffsetMs(new Date(wallMidnight), timeZone);
  guess = wallMidnight - timeZoneOffsetMs(new Date(guess), timeZone);
  // If midnight does not exist (DST gap at 00:00), move forward until the date matches.
  let instant = new Date(guess);
  if (localDateOf(instant, timeZone) !== date) {
    for (let step = 0; step < 4 * 60; step++) {
      instant = new Date(guess + step * 60_000);
      if (localDateOf(instant, timeZone) === date) break;
    }
  }
  // If an earlier instant also maps to this date (DST overlap), walk back to the true start.
  while (localDateOf(new Date(instant.getTime() - 60_000), timeZone) === date) {
    instant = new Date(instant.getTime() - 60_000);
  }
  return instant;
}

/** Whether a card with this due date is due at `now` in the timezone. */
export function isDue(dueDate: LocalDate, now: Date, timeZone: string): boolean {
  return compareDates(dueDate, localDateOf(now, timeZone)) <= 0;
}

/** Inclusive list of calendar dates. */
export function dateRange(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  const n = diffDays(from, to);
  for (let i = 0; i <= n; i++) out.push(addDays(from, i));
  return out;
}

/** ISO weekday 1 (Mon) … 7 (Sun) for a calendar date. */
export function isoWeekday(date: LocalDate): number {
  const [y, m, d] = parse(date);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}
