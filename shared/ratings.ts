/** The four personal recall ratings. Stored as integers 1–4. */
export type Rating = 1 | 2 | 3 | 4;

export const RATINGS: readonly Rating[] = [1, 2, 3, 4];

export const RATING_BAD: Rating = 1;
export const RATING_GOOD: Rating = 2;
export const RATING_VERY_GOOD: Rating = 3;
export const RATING_PERFECT: Rating = 4;

export interface RatingInfo {
  value: Rating;
  key: string;
  label: string;
  meaning: string;
  sessionEffect: string;
  tone: 'bad' | 'good' | 'verygood' | 'perfect';
}

export const RATING_INFO: Record<Rating, RatingInfo> = {
  1: {
    value: 1,
    key: '1',
    label: 'Bad',
    meaning: 'I did not know it or got it wrong',
    sessionEffect: 'Returns after 2 other card attempts',
    tone: 'bad',
  },
  2: {
    value: 2,
    key: '2',
    label: 'Good',
    meaning: 'I partly knew it or needed significant effort',
    sessionEffect: 'Returns after 5 other card attempts',
    tone: 'good',
  },
  3: {
    value: 3,
    key: '3',
    label: 'Very good',
    meaning: 'I answered correctly with reasonable confidence',
    sessionEffect: 'Done for this session',
    tone: 'verygood',
  },
  4: {
    value: 4,
    key: '4',
    label: 'Perfect',
    meaning: 'I answered immediately and confidently',
    sessionEffect: 'Done for this session',
    tone: 'perfect',
  },
};

export function isRating(value: unknown): value is Rating {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

/** Bad and Good mean the card needs more practice. */
export function isWeakRating(rating: Rating | null | undefined): boolean {
  return rating === 1 || rating === 2;
}

/** Very good and Perfect count as recalled. */
export function isRecalledRating(rating: Rating | null | undefined): boolean {
  return rating === 3 || rating === 4;
}

export type StudyMode = 'scheduled' | 'practice' | 'test';

export const MODE_LABEL: Record<StudyMode, string> = {
  scheduled: 'Scheduled review',
  practice: 'Practice',
  test: 'Test once',
};
