import { Check, CheckCheck, Minus, X } from 'lucide-react';
import { RATING_INFO, type Rating } from '../../shared/ratings.ts';
import { Badge } from './ui/Feedback.tsx';

export const RATING_COLOR: Record<Rating, string> = {
  1: 'var(--rating-bad)',
  2: 'var(--rating-good)',
  3: 'var(--rating-verygood)',
  4: 'var(--rating-perfect)',
};

export const RATING_ICON = { 1: X, 2: Minus, 3: Check, 4: CheckCheck } as const;

export function RatingBadge({ rating }: { rating: Rating | null }) {
  if (!rating) return <Badge>Not rated</Badge>;
  const Icon = RATING_ICON[rating];
  return (
    <Badge tone={RATING_INFO[rating].tone} icon={<Icon className="size-3" aria-hidden />}>
      {RATING_INFO[rating].label}
    </Badge>
  );
}

export function ratingParts(counts: Record<Rating, number>) {
  return ([1, 2, 3, 4] as Rating[]).map((r) => ({ key: String(r), label: RATING_INFO[r].label, value: counts[r] ?? 0, color: RATING_COLOR[r] }));
}
