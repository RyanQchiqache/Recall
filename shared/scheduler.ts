/**
 * Recall's initial long-term scheduler ("recall-heuristic-v1").
 *
 * A deliberately simple, transparent, configurable heuristic. It is an original
 * product rule — not FSRS, SM-2, Vaia's algorithm, or a calibrated retention model.
 *
 * Only the first rating of a card in a scheduled-review session is passed here.
 * Everything is pure: no clock, no I/O. Callers supply the review instant and timezone.
 */
import { addDays, localDateOf, type LocalDate } from './dates.ts';
import type { Rating } from './ratings.ts';

export const HEURISTIC_V1 = 'recall-heuristic-v1';

export interface RatingRule {
  /** Interval for a new card, and the minimum interval for a reviewed card. */
  base: number;
  /** Multiplier applied to the previous interval. `null` means "always use base". */
  multiplier: number | null;
}

export interface SchedulerSettings {
  bad: RatingRule;
  good: RatingRule;
  veryGood: RatingRule;
  perfect: RatingRule;
  maxIntervalDays: number;
}

export const DEFAULT_SCHEDULER_SETTINGS: SchedulerSettings = {
  bad: { base: 1, multiplier: null },
  good: { base: 2, multiplier: 1.2 },
  veryGood: { base: 4, multiplier: 2 },
  perfect: { base: 7, multiplier: 3 },
  maxIntervalDays: 365,
};

/** Long-term scheduling state for one card. `null` means the card has never been reviewed. */
export interface ScheduleState {
  dueDate: LocalDate;
  intervalDays: number;
  reviewCount: number;
  lapseCount: number;
  firstReviewedAt: string; // ISO UTC
  lastReviewedAt: string; // ISO UTC
  lastRating: Rating;
  schedulerVersion: string;
}

export interface ScheduleInput {
  previous: ScheduleState | null;
  rating: Rating;
  reviewedAt: Date;
  timeZone: string;
  settings: SchedulerSettings;
}

export interface Scheduler {
  readonly version: string;
  next(input: ScheduleInput): ScheduleState;
}

function ruleFor(settings: SchedulerSettings, rating: Rating): RatingRule {
  switch (rating) {
    case 1:
      return settings.bad;
    case 2:
      return settings.good;
    case 3:
      return settings.veryGood;
    case 4:
      return settings.perfect;
  }
}

/** ceil() that ignores floating-point noise such as 10 × 1.2 = 12.000000000000002. */
function safeCeil(x: number): number {
  return Math.ceil(Math.round(x * 1e9) / 1e9);
}

/** Next interval in whole days, per the v1 table. */
export function nextIntervalDays(
  previousInterval: number | null,
  rating: Rating,
  settings: SchedulerSettings = DEFAULT_SCHEDULER_SETTINGS,
): number {
  const rule = ruleFor(settings, rating);
  const base = Math.max(1, Math.round(rule.base));
  let interval: number;
  if (previousInterval === null || rule.multiplier === null) {
    interval = base;
  } else {
    interval = Math.max(base, safeCeil(previousInterval * rule.multiplier));
  }
  const cap = Math.max(1, Math.round(settings.maxIntervalDays));
  return Math.min(cap, interval);
}

export const heuristicV1: Scheduler = {
  version: HEURISTIC_V1,
  next({ previous, rating, reviewedAt, timeZone, settings }: ScheduleInput): ScheduleState {
    const interval = nextIntervalDays(previous ? previous.intervalDays : null, rating, settings);
    const reviewDay = localDateOf(reviewedAt, timeZone);
    const iso = reviewedAt.toISOString();
    return {
      dueDate: addDays(reviewDay, interval),
      intervalDays: interval,
      reviewCount: (previous?.reviewCount ?? 0) + 1,
      // A lapse is Bad on a previously reviewed card. Called once per scheduled session.
      lapseCount: (previous?.lapseCount ?? 0) + (previous && rating === 1 ? 1 : 0),
      firstReviewedAt: previous?.firstReviewedAt ?? iso,
      lastReviewedAt: iso,
      lastRating: rating,
      schedulerVersion: HEURISTIC_V1,
    };
  },
};

const SCHEDULERS: Record<string, Scheduler> = { [HEURISTIC_V1]: heuristicV1 };

export function getScheduler(version: string = HEURISTIC_V1): Scheduler {
  const s = SCHEDULERS[version];
  if (!s) throw new Error(`Unknown scheduler version: ${version}`);
  return s;
}

export function normalizeSchedulerSettings(input: unknown): SchedulerSettings {
  const d = DEFAULT_SCHEDULER_SETTINGS;
  const src = (input && typeof input === 'object' ? input : {}) as Partial<SchedulerSettings>;
  const rule = (r: Partial<RatingRule> | undefined, def: RatingRule, allowMult: boolean): RatingRule => {
    const base = Number(r?.base);
    const mult = r?.multiplier === null ? null : Number(r?.multiplier);
    return {
      base: Number.isFinite(base) && base >= 1 && base <= 3650 ? Math.round(base) : def.base,
      multiplier: !allowMult
        ? null
        : mult !== null && Number.isFinite(mult) && mult >= 1 && mult <= 10
          ? mult
          : def.multiplier,
    };
  };
  const max = Number(src.maxIntervalDays);
  return {
    bad: rule(src.bad, d.bad, false),
    good: rule(src.good, d.good, true),
    veryGood: rule(src.veryGood, d.veryGood, true),
    perfect: rule(src.perfect, d.perfect, true),
    maxIntervalDays: Number.isFinite(max) && max >= 1 && max <= 3650 ? Math.round(max) : d.maxIntervalDays,
  };
}
