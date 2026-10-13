# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
One university student (currently M.Sc. Informatics), studying alone at a laptop at a desk. Sessions are long and focused, typically building up toward exams. Course material is technical: equations (LaTeX), code, diagrams and long written answers.

## Product Purpose
Recall is a private, offline flashcard workspace. The student organizes programs → semesters → courses → sections → cards, writes cards in Markdown with math, code and images, and tests themselves in configurable sessions. Success means the student keeps coming back day after day, can see their knowledge growing, and walks into exams knowing which material is solid and which is weak.

## Positioning
Fully local and transparent: no AI, no cloud, no account, no telemetry. Scheduling is a deliberately simple, visible rule (`recall-heuristic-v1`) driven by four personal ratings (Bad, Good, Very good, Perfect), not a black-box memory model. The student owns a single SQLite file.

## Operating Context
- Runs at `http://127.0.0.1:4317` in a desktop browser; the app opens on startup from the terminal.
- Study flow: dashboard → session builder (scope, mode, size, order, filters) → study screen (reveal, rate 1–4, undo, pause) → results.
- Three modes: Scheduled review (changes the schedule), Practice, Test once.
- Keyboard-heavy: `/` search, `Space` reveal, `1`–`4` rate, `U` undo, `P`/`Esc` pause.
- Light and dark themes, following the system setting by default.

## Capabilities and Constraints
- Feature set is complete for now: the redesign changes the visual identity and presentation, **not** features, flows or data. No new features ("don't bloat").
- Must work fully offline: no hosted fonts, CDNs or remote assets; everything ships via npm/Vite.
- Stack: React 19, React Router 7, TanStack Query, Tailwind CSS 4, Radix UI, lucide-react, KaTeX, highlight.js.
- Mobile layout (390px) already exists and must keep working, though desk use is primary.

## Brand Commitments
- Name: **Recall**.
- The four rating names and their meanings are product terminology and stay unchanged.
- Motivation must feel grown-up: no mascots, confetti, XP bars, cartoon badges or childish gamification.
- Must not look like generic corporate SaaS or an admin dashboard.
- Visual direction (chosen 2026-10-13): the category standard for study apps, played straight at full craft. Linear is the quality bar: crisp, dense, keyboard-first, precise type and hairline detail.

## Evidence on Hand
- Demo course: "Computer Vision (demo)", clearly labelled as sample material.
- Real statistics exist in the app: streak, 14-day activity, heatmap, first-attempt vs after-repeat accuracy, weak sections. Motivation must come from this real data, never from invented numbers.

## Product Principles
1. Studying comes first; every screen is one step away from starting or continuing a session.
2. Progress is made visible from real data so the student feels momentum across days.
3. Calm focus: the card and its content (math, code) are the loudest thing on the study screen.
4. Honest and transparent: the app says exactly what it will do (how many cards, what changes the schedule).
5. Grown-up encouragement: warmth and pride without games or gimmicks.

## Accessibility & Inclusion
Full keyboard operation is a core workflow. Respect `prefers-reduced-motion`. Keep WCAG AA contrast in both themes.
