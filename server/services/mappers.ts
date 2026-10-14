import type { Rating, StudyMode } from '../../shared/ratings.ts';
import type {
  Card,
  CardSchedule,
  CardStatus,
  Course,
  Program,
  Section,
  SectionKind,
  Semester,
} from '../../shared/types.ts';

// Row types mirror the SQLite columns.
export interface ProgramRow {
  id: string;
  title: string;
  description: string;
  position: number;
  is_demo: number;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface SemesterRow extends Omit<ProgramRow, 'description'> {
  program_id: string;
  start_date: string | null;
  end_date: string | null;
}
export interface CourseRow extends ProgramRow {
  semester_id: string;
  module_code: string;
  color: string;
  icon: string;
  exam_date: string | null;
  exam_set_at: string | null;
}
export interface SectionRow extends Omit<ProgramRow, 'description'> {
  course_id: string;
  kind: string;
  week_number: number | null;
  date: string | null;
  notes: string;
}
export interface CardRow {
  id: string;
  section_id: string;
  front: string;
  back: string;
  explanation: string;
  hint: string;
  source: string;
  bookmarked: number;
  suspended_at: string | null;
  deleted_at: string | null;
  position: number;
  revision: number;
  is_demo: number;
  created_at: string;
  updated_at: string;
}
export interface ScheduleRow {
  card_id: string;
  due_date: string;
  interval_days: number;
  review_count: number;
  lapse_count: number;
  first_reviewed_at: string;
  last_reviewed_at: string;
  last_rating: number;
  scheduler_version: string;
  updated_at: string;
}

const life = (r: { is_demo: number; archived_at: string | null; deleted_at: string | null; created_at: string; updated_at: string }) => ({
  isDemo: r.is_demo === 1,
  archivedAt: r.archived_at,
  deletedAt: r.deleted_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const toProgram = (r: ProgramRow): Program => ({
  id: r.id,
  title: r.title,
  description: r.description,
  position: r.position,
  ...life(r),
});

export const toSemester = (r: SemesterRow): Semester => ({
  id: r.id,
  programId: r.program_id,
  title: r.title,
  startDate: r.start_date,
  endDate: r.end_date,
  position: r.position,
  ...life(r),
});

export const toCourse = (r: CourseRow): Course => ({
  id: r.id,
  semesterId: r.semester_id,
  title: r.title,
  moduleCode: r.module_code,
  color: r.color,
  icon: r.icon,
  description: r.description,
  examDate: r.exam_date,
  examSetAt: r.exam_set_at,
  position: r.position,
  ...life(r),
});

export const toSection = (r: SectionRow): Section => ({
  id: r.id,
  courseId: r.course_id,
  title: r.title,
  kind: r.kind as SectionKind,
  weekNumber: r.week_number,
  date: r.date,
  notes: r.notes,
  position: r.position,
  ...life(r),
});

export const toSchedule = (r: ScheduleRow): CardSchedule => ({
  dueDate: r.due_date,
  intervalDays: r.interval_days,
  reviewCount: r.review_count,
  lapseCount: r.lapse_count,
  lastRating: r.last_rating as Rating,
  firstReviewedAt: r.first_reviewed_at,
  lastReviewedAt: r.last_reviewed_at,
  schedulerVersion: r.scheduler_version,
});

export interface CardListRow extends CardRow {
  course_id: string;
  section_title: string;
  course_title: string;
  s_due_date: string | null;
  s_interval_days: number | null;
  s_review_count: number | null;
  s_lapse_count: number | null;
  s_first_reviewed_at: string | null;
  s_last_reviewed_at: string | null;
  s_last_rating: number | null;
  s_scheduler_version: string | null;
  last_any_rating: number | null;
  last_any_mode: string | null;
  tag_list: string | null;
}

export function cardStatus(suspended: boolean, dueDate: string | null, today: string): CardStatus {
  if (suspended) return 'suspended';
  if (dueDate === null) return 'new';
  return dueDate <= today ? 'due' : 'scheduled';
}

export function toCard(r: CardListRow, today: string): Card {
  const schedule: CardSchedule | null =
    r.s_due_date === null
      ? null
      : {
          dueDate: r.s_due_date,
          intervalDays: r.s_interval_days ?? 0,
          reviewCount: r.s_review_count ?? 0,
          lapseCount: r.s_lapse_count ?? 0,
          lastRating: (r.s_last_rating ?? 1) as Rating,
          firstReviewedAt: r.s_first_reviewed_at ?? '',
          lastReviewedAt: r.s_last_reviewed_at ?? '',
          schedulerVersion: r.s_scheduler_version ?? '',
        };
  return {
    id: r.id,
    sectionId: r.section_id,
    courseId: r.course_id,
    front: r.front,
    back: r.back,
    explanation: r.explanation,
    hint: r.hint,
    source: r.source,
    bookmarked: r.bookmarked === 1,
    suspendedAt: r.suspended_at,
    position: r.position,
    revision: r.revision,
    isDemo: r.is_demo === 1,
    tags: r.tag_list ? r.tag_list.split('\u001f').sort((a, b) => a.localeCompare(b)) : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    schedule,
    status: cardStatus(r.suspended_at !== null, r.s_due_date, today),
    lastRating: (r.last_any_rating ?? null) as Rating | null,
    lastRatingMode: (r.last_any_mode ?? null) as StudyMode | null,
    sectionTitle: r.section_title,
    courseTitle: r.course_title,
  };
}

/** SELECT list for card queries over `card_ctx c` with schedule `cs`. */
export const CARD_SELECT = `
  c.id, c.section_id, c.front, c.back, c.explanation, c.hint, c.source, c.bookmarked,
  c.suspended_at, c.deleted_at, c.position, c.revision, c.is_demo, c.created_at, c.updated_at,
  c.course_id,
  (SELECT title FROM sections WHERE id = c.section_id) AS section_title,
  (SELECT title FROM courses WHERE id = c.course_id) AS course_title,
  cs.due_date AS s_due_date, cs.interval_days AS s_interval_days, cs.review_count AS s_review_count,
  cs.lapse_count AS s_lapse_count, cs.first_reviewed_at AS s_first_reviewed_at,
  cs.last_reviewed_at AS s_last_reviewed_at, cs.last_rating AS s_last_rating,
  cs.scheduler_version AS s_scheduler_version,
  (SELECT re.rating FROM review_events re WHERE re.card_id = c.id AND re.undone_at IS NULL
     ORDER BY re.rated_at DESC, re.attempt_index DESC LIMIT 1) AS last_any_rating,
  (SELECT re.mode FROM review_events re WHERE re.card_id = c.id AND re.undone_at IS NULL
     ORDER BY re.rated_at DESC, re.attempt_index DESC LIMIT 1) AS last_any_mode,
  (SELECT group_concat(t.name, char(31)) FROM card_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.card_id = c.id) AS tag_list
`;
