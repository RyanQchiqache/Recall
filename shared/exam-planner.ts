import { addDays, diffDays, type LocalDate } from './dates.ts';

export interface ExamPlanDay {
  date: LocalDate;
  learn: number;
  revise: number;
  total: number;
  heavy: boolean;
}

export interface ExamWorkload {
  daysToExam: number;
  bufferDays: number;
  days: ExamPlanDay[];
}

export interface ExamPlannerInput {
  today: LocalDate;
  examDate: LocalDate;
  newCards: number;
  dueDates: LocalDate[];
  horizonDays?: number;
}

/** The final scheduled-review date for an upcoming exam. */
export function examReviewDeadline(examDate: LocalDate, reviewDay: LocalDate): LocalDate | undefined {
  return examDate > reviewDay ? addDays(examDate, -1) : undefined;
}

/**
 * Build the current exam plan. Future review counts include schedules that
 * already exist; ratings made between now and then can still move those dates.
 */
export function buildExamWorkload(input: ExamPlannerInput): ExamWorkload {
  const daysToExam = diffDays(input.today, input.examDate);
  if (daysToExam < 0) return { daysToExam, bufferDays: 0, days: [] };

  const horizon = Math.max(1, Math.min(31, Math.floor(input.horizonDays ?? 7)));
  const dayCount = Math.min(horizon, daysToExam + 1);
  const dates = Array.from({ length: dayCount }, (_, index) => addDays(input.today, index));
  const lastDate = dates.at(-1)!;
  const deadline = addDays(input.examDate, -1);
  const reviewCounts = new Map<LocalDate, number>();

  for (const dueDate of input.dueDates) {
    const capped = dueDate > deadline ? deadline : dueDate;
    const plannedDate = capped <= input.today ? input.today : capped;
    if (plannedDate <= lastDate) reviewCounts.set(plannedDate, (reviewCounts.get(plannedDate) ?? 0) + 1);
  }

  let remainingNew = Math.max(0, Math.floor(input.newCards));
  const days = dates.map((date): ExamPlanDay => {
    const remainingDaysToExam = diffDays(date, input.examDate);
    const bufferDays = Math.min(3, Math.max(0, remainingDaysToExam - 1));
    const learningDaysLeft = Math.max(1, remainingDaysToExam - bufferDays);
    const learn = remainingNew > 0 ? Math.ceil(remainingNew / learningDaysLeft) : 0;
    remainingNew = Math.max(0, remainingNew - learn);
    const revise = reviewCounts.get(date) ?? 0;
    return { date, learn, revise, total: learn + revise, heavy: false };
  });

  const average = days.reduce((sum, day) => sum + day.total, 0) / Math.max(1, days.length);
  const heavyAt = Math.max(20, Math.ceil(average * 1.5));
  for (const day of days) day.heavy = day.total >= heavyAt;

  return {
    daysToExam,
    bufferDays: Math.min(3, Math.max(0, daysToExam - 1)),
    days,
  };
}
