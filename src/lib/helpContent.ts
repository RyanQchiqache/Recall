export const HELP_CATEGORIES = [
  { id: 'start', label: 'Getting started', description: 'Set up your library and understand where Recall keeps your work.' },
  { id: 'cards', label: 'Creating cards', description: 'Write, organize and safely edit useful cards.' },
  { id: 'study', label: 'Studying', description: 'Choose a session, answer cards and understand the four ratings.' },
  { id: 'exams', label: 'Exam planning', description: 'Turn an exam date into a daily learn-and-revise plan.' },
  { id: 'progress', label: 'Progress and organization', description: 'Read statistics, find cards and keep the library tidy.' },
  { id: 'data', label: 'Settings and data safety', description: 'Adjust Recall and protect or move your local data.' },
] as const;

export type HelpCategoryId = (typeof HELP_CATEGORIES)[number]['id'];

export interface HelpLink {
  label: string;
  to: string;
}

export interface HelpItem {
  id: string;
  category: HelpCategoryId;
  question: string;
  answer: string;
  bullets?: string[];
  terms?: string[];
  link?: HelpLink;
}

export const HELP_ITEMS: HelpItem[] = [
  {
    id: 'library-structure',
    category: 'start',
    question: 'How is my library organized?',
    answer: 'Recall uses five levels: study program, semester, course, section and card. A section is usually a week, lecture or topic inside a course.',
    bullets: ['Use Organize to create, rename, move, archive or reorder the hierarchy.', 'Use the library tree in the sidebar to open a course or section quickly.'],
    terms: ['program semester course section hierarchy'],
    link: { label: 'Open Organize', to: '/organize' },
  },
  {
    id: 'first-course',
    category: 'start',
    question: 'How do I create my first course?',
    answer: 'Open Organize and create a program, semester, course and first section. Cards always belong to a section, so Recall needs those four levels before the first card.',
    link: { label: 'Set up the library', to: '/organize' },
  },
  {
    id: 'demo-content',
    category: 'start',
    question: 'What is the demo course?',
    answer: 'It is optional sample content that demonstrates equations, code, images and longer answers. It is clearly marked as demo material and can be removed in one action without touching your own courses.',
    link: { label: 'Manage demo content', to: '/settings#demo' },
  },
  {
    id: 'local-data',
    category: 'start',
    question: 'Is anything sent to the internet?',
    answer: 'No. Recall has no account, cloud service, AI service, telemetry or remote assets. The app and its help content work locally on this computer.',
    terms: ['privacy offline cloud account telemetry AI'],
    link: { label: 'See data locations', to: '/settings#data' },
  },
  {
    id: 'create-card',
    category: 'cards',
    question: 'How do I add a card?',
    answer: 'Open a section and choose Add card. Write a question on the front and the answer on the back, check the preview, then save. Save & add next keeps the same section open for rapid entry.',
  },
  {
    id: 'card-formatting',
    category: 'cards',
    question: 'How do Markdown, equations, code and images work?',
    answer: 'The card editor previews Markdown as you type. Use dollar signs for LaTeX math, fenced blocks for code, and the image button or file picker to upload an image into Recall’s local media folder.',
    bullets: ['Remote images are not fetched.', 'Uploaded PNG, JPEG, GIF and WebP files are included in full backups.'],
    terms: ['latex katex markdown upload photo diagram'],
  },
  {
    id: 'drafts',
    category: 'cards',
    question: 'What happens if I leave an unfinished card?',
    answer: 'Recall saves the draft locally. Returning to the same new or existing card restores it. If the saved card changed elsewhere, Recall shows a conflict instead of silently overwriting either version.',
    terms: ['autosave conflict revision unsaved'],
  },
  {
    id: 'tags-bookmarks',
    category: 'cards',
    question: 'What are tags and bookmarks for?',
    answer: 'Tags describe topics across the hierarchy, while a bookmark marks an individual card for quick filtering. Both can be used in card search and session filters.',
    terms: ['label favourite favorite'],
    link: { label: 'Search and filter cards', to: '/search' },
  },
  {
    id: 'duplicate-card',
    category: 'cards',
    question: 'Can I duplicate, move or edit several cards?',
    answer: 'A card can be duplicated from its editor. On a section page, select multiple cards to move, tag, bookmark, suspend or send them to the Trash together.',
  },
  {
    id: 'study-modes',
    category: 'study',
    question: 'What is the difference between Scheduled review, Practice and Test once?',
    answer: 'Scheduled review chooses due cards and optionally new cards; the first rating of each card changes its next review date. Practice can use any matching cards and never changes schedules. Test once gives each card one attempt and lets you type a draft answer before revealing.',
    terms: ['mode schedule testing'],
    link: { label: 'Build a study session', to: '/study/new' },
  },
  {
    id: 'include-new',
    category: 'study',
    question: 'What does “Include new cards” do?',
    answer: 'In Scheduled review, Recall selects due cards first and then fills remaining session places with cards that have never been scheduled. Turning it off creates a due-only scheduled session.',
    terms: ['new due-only'],
  },
  {
    id: 'session-size',
    category: 'study',
    question: 'What do session size and maximum attempts change?',
    answer: 'Session size is the maximum number of unique cards selected. Maximum attempts is how many times a difficult card may appear in that session, including its first attempt. Recall never duplicates cards merely to fill the requested size.',
    terms: ['10 20 30 40 50 custom attempts repeats'],
  },
  {
    id: 'session-order',
    category: 'study',
    question: 'What do the session order options mean?',
    answer: 'Oldest due first prioritizes the most overdue cards, then new cards. Course and section order follows your library order in schedule-neutral modes. Random stores one fixed shuffle for the session. Weakest first uses the latest selected-basis rating.',
    terms: ['ordering random weakest oldest due'],
  },
  {
    id: 'session-filters',
    category: 'study',
    question: 'What do the card filters mean?',
    answer: 'Filters can limit a session to new, due, not-yet-due, previously reviewed, weak or bookmarked cards, and to chosen tags. “Weak” means the latest relevant rating was Bad or Good; its basis can include every mode or scheduled reviews only.',
    terms: ['status weak basis bookmarked tags not due reviewed'],
  },
  {
    id: 'ratings',
    category: 'study',
    question: 'What happens when I choose Bad, Good, Very good or Perfect?',
    answer: 'The ratings are personal confidence judgements, not exam scores. Bad means you did not know it; Good means partial knowledge or significant effort; Very good means correct with reasonable confidence; Perfect means immediate and confident.',
    bullets: ['Bad returns after at least 2 other attempts.', 'Good returns after at least 5 other attempts.', 'Very good and Perfect finish the card for this session.'],
    terms: ['1 2 3 4 confidence'],
  },
  {
    id: 'next-review',
    category: 'study',
    question: 'How does a rating set the next review date?',
    answer: 'Only the first rating of a card in a Scheduled review session changes its long-term schedule. Recall applies the visible interval rules from Settings. Practice, Test once and later repeats in the same session do not reschedule it.',
    terms: ['interval scheduler due date heuristic'],
    link: { label: 'See scheduling settings', to: '/settings#scheduling' },
  },
  {
    id: 'undo-pause-resume',
    category: 'study',
    question: 'Can I undo, pause or resume a session?',
    answer: 'Yes. Undo reverses the last rating, its event, schedule and queue change. Pause keeps the session open without counting paused time. Reloading, restarting the browser or restarting Recall resumes the same card and reveal state.',
    terms: ['u ctrl z command z escape p reload'],
  },
  {
    id: 'exam-date',
    category: 'exams',
    question: 'How do I add or remove an exam date?',
    answer: 'Open the course menu and edit the course. Setting an upcoming date adds its daily plan and readiness to the dashboard. Clearing the date removes exam planning without changing cards or review history.',
  },
  {
    id: 'daily-plan',
    category: 'exams',
    question: 'How are Learn today and Revise today calculated?',
    answer: 'Learn today spreads the course’s remaining new cards over the learning days before the exam, normally preserving the final three days for review. Revise today is the number of cards currently due. Skipped work is recalculated from what remains.',
    terms: ['catch up buffer days study plan'],
  },
  {
    id: 'readiness',
    category: 'exams',
    question: 'What do learned, answering well and on track mean?',
    answer: 'Learned is the share of cards studied at least once. Answering well is the share whose latest Scheduled review rating was Very good or Perfect. On track compares learned cards with the even pace since the exam date was set. These are confidence signals, not predicted scores.',
    terms: ['solid behind mastery percentage'],
  },
  {
    id: 'exam-review-cap',
    category: 'exams',
    question: 'Why was a review moved before the exam?',
    answer: 'For a course with an upcoming exam, Recall caps a new due date at the day before the exam. This ensures the normal scheduler does not place the card’s next review after the exam.',
  },
  {
    id: 'exam-passed',
    category: 'exams',
    question: 'What happens after the exam date?',
    answer: 'The dashboard marks the exam as passed and stops producing a daily plan. You can keep the date as a record or clear it from the dashboard or course settings.',
  },
  {
    id: 'statistics',
    category: 'progress',
    question: 'What do the statistics describe?',
    answer: 'Statistics report real activity for the selected place and date range: unique cards, total attempts, active study time, study days, first-attempt ratings, completion after repeats, weak sections, activity and streaks. They do not estimate exam scores.',
    link: { label: 'Open Statistics', to: '/stats' },
  },
  {
    id: 'first-attempt-recall',
    category: 'progress',
    question: 'What is “First-attempt recall” versus “Finished after repeats”?',
    answer: 'First-attempt recall counts cards first rated Very good or Perfect. Finished after repeats also credits cards completed after returning later in the same session. Keeping them separate shows both initial confidence and eventual completion.',
  },
  {
    id: 'search-cards',
    category: 'progress',
    question: 'How do I find a card?',
    answer: 'Press / or open Search cards. Search questions, answers, explanations, sources and tags, then narrow by hierarchy, tag, status or bookmark. Archived content is excluded unless you include it.',
    terms: ['find lookup slash'],
    link: { label: 'Search cards', to: '/search' },
  },
  {
    id: 'archive-suspend-trash',
    category: 'progress',
    question: 'What is the difference between archive, suspend and Trash?',
    answer: 'Archive hides an inactive hierarchy item while keeping it intact. Suspend keeps a card in its section but excludes it from normal study selection. Trash removes an item from active use but keeps it recoverable until permanent deletion.',
    terms: ['delete restore hide'],
    link: { label: 'Open Trash', to: '/trash' },
  },
  {
    id: 'appearance-settings',
    category: 'data',
    question: 'What do the app name and theme settings change?',
    answer: 'App name changes the name shown in the sidebar and browser tab. Theme can follow the operating system or stay light or dark. These options do not affect study data.',
    link: { label: 'Open Appearance settings', to: '/settings#appearance' },
  },
  {
    id: 'timezone-setting',
    category: 'data',
    question: 'Why does Recall need a timezone?',
    answer: 'Due dates, streaks and statistics use local calendar days. A card becomes due at midnight in the configured timezone, and calendar-date calculations avoid daylight-saving shifts.',
    link: { label: 'Open Time & scheduling', to: '/settings#scheduling' },
  },
  {
    id: 'scheduler-settings',
    category: 'data',
    question: 'What happens if I change the interval rules?',
    answer: 'The new rules apply only to future Scheduled review ratings. Recall never rewrites existing due dates. Each session also keeps a snapshot of the settings it started with.',
    terms: ['base multiplier maximum interval'],
    link: { label: 'Open scheduling settings', to: '/settings#scheduling' },
  },
  {
    id: 'study-settings',
    category: 'data',
    question: 'What do the study-default switches change?',
    answer: 'Default session size and maximum attempts prefill new session builders. Include new cards controls the Scheduled review default. Heatmap and streak only change what is displayed. “Explain the four ratings again” reopens the guide on the next reveal.',
    terms: ['heatmap streak rating guide defaults'],
    link: { label: 'Open Study defaults', to: '/settings#study' },
  },
  {
    id: 'backup-types',
    category: 'data',
    question: 'What is saved in a snapshot, full backup, course package or CSV?',
    answer: 'A snapshot is a local database safety copy and does not include the media folder. A full backup contains all data and images. A course package moves one course and its images, optionally with schedules. CSV carries card text and organization fields but is not a complete backup.',
    terms: ['zip export import media images'],
    link: { label: 'Open Backups & import', to: '/settings#backups' },
  },
  {
    id: 'restore-safety',
    category: 'data',
    question: 'What happens when I restore or import a file?',
    answer: 'Recall first validates the entire file and shows a preview. A full restore replaces all data only after confirmation and creates a pre-restore snapshot. A course package adds a new course. A failed validation or import leaves current data untouched.',
    terms: ['replace preview rollback'],
  },
  {
    id: 'automatic-snapshots',
    category: 'data',
    question: 'Do automatic snapshots protect me if the computer is lost?',
    answer: 'No. Snapshots protect against local database mistakes but normally live on the same disk. Export full backups regularly and copy them to a separate drive or another safe location.',
    terms: ['retention folder interval disk failure'],
    link: { label: 'Manage snapshots', to: '/settings#backups' },
  },
  {
    id: 'keyboard-shortcuts',
    category: 'data',
    question: 'Which keyboard shortcuts are available?',
    answer: '/ opens card search. In the editor, Cmd/Ctrl+Enter saves and Cmd/Ctrl+Shift+Enter saves and adds another. During study, Space or Enter reveals, 1–4 rates, H shows the hint, U undoes, P or Escape pauses, and R reviews waiting cards now.',
    terms: ['keys hotkeys'],
  },
];

export function helpSearchText(item: HelpItem): string {
  const category = HELP_CATEGORIES.find((entry) => entry.id === item.category);
  return [category?.label, item.question, item.answer, ...(item.bullets ?? []), ...(item.terms ?? [])].join(' ').toLocaleLowerCase();
}
