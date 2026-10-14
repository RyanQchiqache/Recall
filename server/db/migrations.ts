/**
 * Ordered, append-only schema migrations. Never edit a released migration;
 * add a new one instead. Each runs inside a transaction.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const timestamps = `created_at TEXT NOT NULL, updated_at TEXT NOT NULL`;
const lifecycle = `is_demo INTEGER NOT NULL DEFAULT 0, archived_at TEXT, deleted_at TEXT`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE programs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  ${lifecycle},
  ${timestamps}
);

CREATE TABLE semesters (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  ${lifecycle},
  ${timestamps}
);
CREATE INDEX idx_semesters_program ON semesters(program_id, position);

CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  semester_id TEXT NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  module_code TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'indigo',
  icon TEXT NOT NULL DEFAULT 'book-open',
  description TEXT NOT NULL DEFAULT '',
  exam_date TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  ${lifecycle},
  ${timestamps}
);
CREATE INDEX idx_courses_semester ON courses(semester_id, position);

CREATE TABLE sections (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'lecture',
  week_number INTEGER,
  date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  ${lifecycle},
  ${timestamps}
);
CREATE INDEX idx_sections_course ON sections(course_id, position);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  hint TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  bookmarked INTEGER NOT NULL DEFAULT 0,
  suspended_at TEXT,
  deleted_at TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0,
  ${timestamps}
);
CREATE INDEX idx_cards_section ON cards(section_id, position);
CREATE INDEX idx_cards_created ON cards(created_at, id);

CREATE VIRTUAL TABLE cards_fts USING fts5(
  front, back, explanation, hint, source,
  content='cards', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER cards_ai AFTER INSERT ON cards BEGIN
  INSERT INTO cards_fts(rowid, front, back, explanation, hint, source)
  VALUES (new.rowid, new.front, new.back, new.explanation, new.hint, new.source);
END;
CREATE TRIGGER cards_ad AFTER DELETE ON cards BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, front, back, explanation, hint, source)
  VALUES ('delete', old.rowid, old.front, old.back, old.explanation, old.hint, old.source);
END;
CREATE TRIGGER cards_au AFTER UPDATE OF front, back, explanation, hint, source ON cards BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, front, back, explanation, hint, source)
  VALUES ('delete', old.rowid, old.front, old.back, old.explanation, old.hint, old.source);
  INSERT INTO cards_fts(rowid, front, back, explanation, hint, source)
  VALUES (new.rowid, new.front, new.back, new.explanation, new.hint, new.source);
END;

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);

CREATE TABLE card_tags (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, tag_id)
);
CREATE INDEX idx_card_tags_tag ON card_tags(tag_id);

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_media_sha ON media_assets(sha256);

CREATE TABLE card_schedules (
  card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  due_date TEXT NOT NULL,
  interval_days INTEGER NOT NULL,
  review_count INTEGER NOT NULL DEFAULT 0,
  lapse_count INTEGER NOT NULL DEFAULT 0,
  first_reviewed_at TEXT NOT NULL,
  last_reviewed_at TEXT NOT NULL,
  last_rating INTEGER NOT NULL CHECK (last_rating BETWEEN 1 AND 4),
  scheduler_version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_schedules_due ON card_schedules(due_date);

CREATE TABLE study_sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('scheduled', 'practice', 'test')),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'ended')),
  is_open INTEGER CHECK (is_open IS NULL OR is_open = 1),
  title TEXT NOT NULL DEFAULT '',
  scope_json TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  ordering TEXT NOT NULL,
  seed INTEGER NOT NULL,
  requested_size INTEGER NOT NULL,
  settings_json TEXT NOT NULL,
  scheduler_version TEXT NOT NULL,
  max_attempts INTEGER NOT NULL,
  attempt_counter INTEGER NOT NULL DEFAULT 0,
  next_queue_order INTEGER NOT NULL DEFAULT 0,
  current_card_id TEXT,
  revealed INTEGER NOT NULL DEFAULT 0,
  hint_shown INTEGER NOT NULL DEFAULT 0,
  typed_answer TEXT NOT NULL DEFAULT '',
  relaxed INTEGER NOT NULL DEFAULT 0,
  active_ms INTEGER NOT NULL DEFAULT 0,
  active_ms_marked INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX idx_sessions_one_open ON study_sessions(is_open) WHERE is_open = 1;
CREATE INDEX idx_sessions_started ON study_sessions(started_at);

CREATE TABLE session_cards (
  session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  initial_position INTEGER NOT NULL,
  queue_order INTEGER NOT NULL,
  eligible_after INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'unresolved')),
  first_rating INTEGER CHECK (first_rating IS NULL OR first_rating BETWEEN 1 AND 4),
  final_rating INTEGER CHECK (final_rating IS NULL OR final_rating BETWEEN 1 AND 4),
  selection_reason TEXT NOT NULL DEFAULT '',
  card_revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  section_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  PRIMARY KEY (session_id, card_id)
);
CREATE INDEX idx_session_cards_card ON session_cards(card_id);

CREATE TABLE review_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  rated_at TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,
  card_attempt INTEGER NOT NULL,
  is_first_attempt INTEGER NOT NULL,
  affects_schedule INTEGER NOT NULL,
  schedule_before_json TEXT,
  schedule_after_json TEXT,
  undo_json TEXT NOT NULL,
  undone_at TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  active_ms INTEGER NOT NULL DEFAULT 0,
  typed_answer TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_card ON review_events(card_id, rated_at);
CREATE INDEX idx_events_session ON review_events(session_id, attempt_index);
CREATE INDEX idx_events_rated ON review_events(rated_at);

CREATE TABLE drafts (
  key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Visibility helpers: a row is hidden if it or any ancestor is archived/deleted.
CREATE VIEW section_ctx AS
SELECT s.*, co.semester_id AS semester_id, se.program_id AS program_id,
  (s.deleted_at IS NOT NULL OR co.deleted_at IS NOT NULL OR se.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL) AS in_trash,
  (s.archived_at IS NOT NULL OR co.archived_at IS NOT NULL OR se.archived_at IS NOT NULL OR p.archived_at IS NOT NULL) AS in_archive
FROM sections s
JOIN courses co ON co.id = s.course_id
JOIN semesters se ON se.id = co.semester_id
JOIN programs p ON p.id = se.program_id;

CREATE VIEW card_ctx AS
SELECT c.*, sc.course_id AS course_id, sc.semester_id AS semester_id, sc.program_id AS program_id,
  (c.deleted_at IS NOT NULL OR sc.in_trash) AS in_trash,
  sc.in_archive AS in_archive
FROM cards c
JOIN section_ctx sc ON sc.id = c.section_id;
`,
  },
  {
    version: 2,
    name: 'exam planning anchor',
    sql: `
ALTER TABLE courses ADD COLUMN exam_set_at TEXT;
UPDATE courses SET exam_set_at = updated_at WHERE exam_date IS NOT NULL;
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
