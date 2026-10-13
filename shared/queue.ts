/**
 * Deterministic in-session repetition queue.
 *
 * Rules:
 * - One entry per selected card. Re-rating moves the entry, it never duplicates it.
 * - After Bad/Good at global attempt index t, the card may return only once
 *   at least 2 (Bad) / 5 (Good) further attempts have completed.
 * - The next card is the earliest eligible entry by stored queue order.
 *   Requeued cards move to the tail.
 * - If only delayed entries remain, the queue reports `waiting`; the user can
 *   explicitly relax the gap. No filler cards, no deadlock, no real-time waiting.
 * - Very good / Perfect complete a card. Reaching `maxAttempts` with Bad/Good marks
 *   it unresolved ("Needs another session").
 *
 * All functions are pure and return new state objects.
 */
import type { Rating } from './ratings.ts';

export type EntryStatus = 'pending' | 'completed' | 'unresolved';

export interface QueueEntry {
  cardId: string;
  queueOrder: number;
  /** The card may be shown once `attemptCounter >= eligibleAfter`. */
  eligibleAfter: number;
  attempts: number;
  status: EntryStatus;
  firstRating: Rating | null;
  finalRating: Rating | null;
}

export interface QueueState {
  /** Number of accepted rating attempts in the session so far. */
  attemptCounter: number;
  nextQueueOrder: number;
  maxAttempts: number;
  /** Set when the user explicitly chose "Review remaining cards now". */
  relaxed: boolean;
  currentCardId: string | null;
  entries: QueueEntry[];
}

export const REPEAT_GAP: Record<1 | 2, number> = { 1: 2, 2: 5 };

export const MIN_MAX_ATTEMPTS = 1;
export const MAX_MAX_ATTEMPTS = 10;
export const DEFAULT_MAX_ATTEMPTS = 3;

export type RateOutcome = 'requeued' | 'completed' | 'unresolved';

export interface RateResult {
  state: QueueState;
  outcome: RateOutcome;
  isFirstAttempt: boolean;
  /** 1-based global attempt index of this rating. */
  attemptIndex: number;
  /** 1-based attempt number of this card within the session. */
  cardAttempt: number;
}

export interface NextSelection {
  cardId: string | null;
  /** True when unfinished cards exist but all are still inside their repeat gap. */
  waiting: boolean;
  finished: boolean;
}

export function clampMaxAttempts(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_MAX_ATTEMPTS;
  return Math.min(MAX_MAX_ATTEMPTS, Math.max(MIN_MAX_ATTEMPTS, v));
}

export function createQueue(cardIds: readonly string[], maxAttempts: number): QueueState {
  if (new Set(cardIds).size !== cardIds.length) throw new Error('Session cards must be unique');
  const base: QueueState = {
    attemptCounter: 0,
    nextQueueOrder: cardIds.length,
    maxAttempts: clampMaxAttempts(maxAttempts),
    relaxed: false,
    currentCardId: null,
    entries: cardIds.map((cardId, i) => ({
      cardId,
      queueOrder: i,
      eligibleAfter: 0,
      attempts: 0,
      status: 'pending',
      firstRating: null,
      finalRating: null,
    })),
  };
  return { ...base, currentCardId: selectNext(base).cardId };
}

const byOrder = (a: QueueEntry, b: QueueEntry) => a.queueOrder - b.queueOrder;

export function selectNext(state: QueueState): NextSelection {
  const pending = state.entries.filter((e) => e.status === 'pending').sort(byOrder);
  if (pending.length === 0) return { cardId: null, waiting: false, finished: true };
  const eligible = pending.find((e) => e.eligibleAfter <= state.attemptCounter);
  if (eligible) return { cardId: eligible.cardId, waiting: false, finished: false };
  if (state.relaxed) return { cardId: pending[0].cardId, waiting: false, finished: false };
  return { cardId: null, waiting: true, finished: false };
}

export function rate(state: QueueState, cardId: string, rating: Rating): RateResult {
  if (state.currentCardId !== cardId) {
    throw new QueueError('This card is not the current card of the session');
  }
  const idx = state.entries.findIndex((e) => e.cardId === cardId);
  const entry = state.entries[idx];
  if (!entry || entry.status !== 'pending') throw new QueueError('Card is not pending in this session');

  const attemptIndex = state.attemptCounter + 1;
  const cardAttempt = entry.attempts + 1;
  const isFirstAttempt = entry.attempts === 0;
  let nextQueueOrder = state.nextQueueOrder;
  let outcome: RateOutcome;
  const updated: QueueEntry = {
    ...entry,
    attempts: cardAttempt,
    firstRating: entry.firstRating ?? rating,
    finalRating: rating,
  };

  if (rating === 3 || rating === 4) {
    updated.status = 'completed';
    outcome = 'completed';
  } else if (cardAttempt >= state.maxAttempts) {
    updated.status = 'unresolved';
    outcome = 'unresolved';
  } else {
    updated.eligibleAfter = attemptIndex + REPEAT_GAP[rating];
    updated.queueOrder = nextQueueOrder++;
    outcome = 'requeued';
  }

  const entries = state.entries.slice();
  entries[idx] = updated;
  const next: QueueState = { ...state, entries, attemptCounter: attemptIndex, nextQueueOrder, currentCardId: null };
  next.currentCardId = selectNext(next).cardId;
  return { state: next, outcome, isFirstAttempt, attemptIndex, cardAttempt };
}

/** Explicitly relax the repeat gap when only delayed cards remain. */
export function relax(state: QueueState): QueueState {
  const next = { ...state, relaxed: true };
  next.currentCardId = selectNext(next).cardId;
  return next;
}

export interface QueueProgress {
  selected: number;
  attempted: number;
  completed: number;
  unresolved: number;
  remaining: number;
  totalAttempts: number;
}

export function progressOf(state: QueueState): QueueProgress {
  let attempted = 0;
  let completed = 0;
  let unresolved = 0;
  for (const e of state.entries) {
    if (e.attempts > 0) attempted++;
    if (e.status === 'completed') completed++;
    if (e.status === 'unresolved') unresolved++;
  }
  return {
    selected: state.entries.length,
    attempted,
    completed,
    unresolved,
    remaining: state.entries.length - completed - unresolved,
    totalAttempts: state.attemptCounter,
  };
}

export class QueueError extends Error {}
