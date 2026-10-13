import { describe, expect, it } from 'vitest';
import { createQueue, progressOf, rate, relax, selectNext, type QueueState } from '../shared/queue.ts';
import type { Rating } from '../shared/ratings.ts';

/** Rate the current card and return [cardId, newState]. */
function step(s: QueueState, r: Rating): [string, QueueState] {
  const id = s.currentCardId!;
  return [id, rate(s, id, r).state];
}

describe('in-session repetition queue', () => {
  it('returns a Bad card only after two other attempts', () => {
    let s = createQueue(['A', 'B', 'C', 'D'], 3);
    expect(s.currentCardId).toBe('A');
    let id: string;
    [id, s] = step(s, 1); // A Bad at attempt 1 → eligible after attempt 3
    expect(id).toBe('A');
    expect(s.currentCardId).toBe('B');
    [, s] = step(s, 3); // B
    expect(s.currentCardId).toBe('C'); // A not yet (only 1 other attempt)
    [, s] = step(s, 3); // C
    // A is now eligible, but D has an earlier queue order (A moved to the tail).
    expect(s.currentCardId).toBe('D');
    [, s] = step(s, 3);
    expect(s.currentCardId).toBe('A');
  });

  it('never shows a Bad card immediately even when it is the earliest entry', () => {
    let s = createQueue(['A', 'B', 'C'], 3);
    [, s] = step(s, 1); // A
    expect(s.currentCardId).not.toBe('A');
    [, s] = step(s, 1); // B
    expect(s.currentCardId).toBe('C');
    [, s] = step(s, 3); // C done; A eligible (2 attempts since)
    expect(s.currentCardId).toBe('A');
  });

  it('requires five other attempts after Good', () => {
    let s = createQueue(['A', 'B', 'C', 'D', 'E', 'F', 'G'], 3);
    [, s] = step(s, 2); // A Good at attempt 1 → eligible after 6
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      seen.push(s.currentCardId!);
      [, s] = step(s, 3);
    }
    expect(seen).toEqual(['B', 'C', 'D', 'E', 'F']);
    expect(s.currentCardId).toBe('G'); // G still precedes A in queue order
    [, s] = step(s, 3);
    expect(s.currentCardId).toBe('A');
  });

  it('waits instead of deadlocking when only delayed cards remain, and relaxes on request', () => {
    let s = createQueue(['A', 'B'], 3);
    [, s] = step(s, 2); // A Good
    [, s] = step(s, 3); // B done
    const next = selectNext(s);
    expect(next).toEqual({ cardId: null, waiting: true, finished: false });
    expect(s.currentCardId).toBeNull();
    s = relax(s);
    expect(s.currentCardId).toBe('A');
  });

  it('handles a one-card session through the same relaxation prompt', () => {
    let s = createQueue(['A'], 3);
    [, s] = step(s, 1);
    expect(selectNext(s).waiting).toBe(true);
    s = relax(s);
    expect(s.currentCardId).toBe('A');
    [, s] = step(s, 4);
    expect(selectNext(s).finished).toBe(true);
  });

  it('completes on Very good / Perfect and marks unresolved after the attempt cap', () => {
    let s = createQueue(['A'], 3);
    s = relax(s);
    [, s] = step(s, 1);
    [, s] = step(s, 2);
    const r = rate(s, 'A', 2); // third attempt, still not recalled
    expect(r.outcome).toBe('unresolved');
    expect(r.state.entries[0]).toMatchObject({ status: 'unresolved', attempts: 3, firstRating: 1, finalRating: 2 });
    expect(selectNext(r.state).finished).toBe(true);
  });

  it('keeps one entry per card and tracks progress precisely', () => {
    let s = createQueue(['A', 'B', 'C', 'D'], 3);
    [, s] = step(s, 1);
    [, s] = step(s, 2);
    [, s] = step(s, 3);
    expect(s.entries).toHaveLength(4);
    expect(new Set(s.entries.map((e) => e.cardId)).size).toBe(4);
    expect(progressOf(s)).toEqual({ selected: 4, attempted: 3, completed: 1, unresolved: 0, remaining: 3, totalAttempts: 3 });
  });

  it('refuses duplicate cards and rating a non-current card', () => {
    expect(() => createQueue(['A', 'A'], 3)).toThrow();
    const s = createQueue(['A', 'B'], 3);
    expect(() => rate(s, 'B', 3)).toThrow();
  });

  it('allows a configurable attempt cap, including test-once (cap 1)', () => {
    const s = createQueue(['A', 'B'], 1);
    const r = rate(s, 'A', 1);
    expect(r.outcome).toBe('unresolved');
    expect(r.state.currentCardId).toBe('B');
  });

  it('is deterministic for a long mixed sequence', () => {
    const run = () => {
      let s = createQueue(['A', 'B', 'C', 'D', 'E'], 3);
      const order: string[] = [];
      const ratings: Rating[] = [1, 2, 1, 3, 4, 1, 3, 2, 4, 3, 1, 4, 3, 3, 3];
      let i = 0;
      while (!selectNext(s).finished && i < 50) {
        if (!s.currentCardId) s = relax(s);
        order.push(s.currentCardId!);
        s = rate(s, s.currentCardId!, ratings[i % ratings.length]).state;
        i++;
      }
      return order.join('');
    };
    expect(run()).toBe(run());
  });
});
