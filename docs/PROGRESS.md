# Recall — implementation checklist

Status as of 2026-10-16. See `README.md` for setup and usage.

## Done

- [x] Local app/API/SQLite, migrations, full hierarchy CRUD, archive, Trash, reorder, move, duplicate and responsive navigation
- [x] Card editor: Markdown, KaTeX, highlighted code, local images, live preview, server-side drafts, tags, hint, source, explanation, Save & add next and edit-conflict handling
- [x] Search with FTS5 and substring matching, filters and bulk move/tag/bookmark/suspend/delete
- [x] Session builder with scope, three modes, size, ordering and filters; study screen with reveal, four ratings, repeat queue, attempt cap, Undo, pause/resume and results
- [x] Transparent scheduler v1 with per-session settings snapshots and DST-safe calendar dates
- [x] Exam planning: per-course exam dates, daily learn/revise plans, readiness, catch-up pacing and reviews capped before the exam
- [x] Card and section reordering, preserved through reloads, exports and imports
- [x] Statistics by mode, first-attempt versus after-repeat results, weak sections and optional heatmap/streak
- [x] Full backup ZIP export/restore, course packages, CSV import/export, SQLite snapshots with retention and demo content
- [x] Security: loopback-only bind, Host/Origin/custom-header checks, CSP, upload validation and sanitized Markdown
- [x] Draft, stale-state, query refresh, onboarding, date validation, delete retry, mobile drawer and empty-section fixes from the previous handoff
- [x] Frontend assets added by a rebuild are served without causing the former blank-screen failure
- [x] Permanent fully offline **How to use Recall** page with search, 34 question-and-answer topics, expandable answers and links to relevant screens
- [x] Tests: 77 passing with clean typecheck and production build
- [x] Browser walkthrough: 28 desktop/mobile screens in light and dark modes, with no overflow, console errors or third-party requests

## UX improvements still to build

Work through these in roughly this order. Each item should be a separate, tested commit. Preserve Recall's local/offline operation, transparent scheduling, confidence-based wording, keyboard-first workflow and calm design.

### 1. Reliable application startup

- [x] Replace the opaque browser launch with a small **Starting Recall** status experience.
- [x] Show progress while starting the server or rebuilding after an update.
- [x] Detect and restart stale or unhealthy servers automatically.
- [x] Do not open the main page until health and current frontend assets are ready.
- [x] On failure, offer **Retry**, **Open log** and **Copy details** with a plain-language explanation.
- [x] Make repeated launches focus the existing instance instead of starting competing servers. (The browser opens the running instance in a tab; an already open tab is not brought to the front.)
- [x] Test fresh launch, existing server, rebuild, stale assets, port conflict, wrong Node version and build failure.

### 2. One-click “Study today”

- [ ] Put one recommended dashboard action such as **Study today · 18 cards · about 12 minutes** above the configurable session flow.
- [ ] Combine cards due now with today's exam-plan new-card allowance and show the exact promised count.
- [ ] Keep **Resume session** primary when a session is already open.
- [ ] Keep the full builder available through **Customize session**.
- [ ] Estimate duration from the user's recent local study time and clearly label it approximate.
- [ ] Handle all-caught-up, multiple-exam, overdue-plan and insufficient-history states.

### 3. Global quick-add card

- [ ] Add a global **New card** action and an `N` shortcut that is ignored while typing or while a dialog is open.
- [ ] Default to the most recently used active section and make the destination easy to change.
- [ ] Return to the originating page after a normal save; keep **Save & add another** for rapid capture.
- [ ] Warn about likely duplicates without blocking intentional duplicates.
- [ ] Reuse the existing draft, conflict, tag, image and Markdown editor behavior.

### 4. Finish the help experience

The searchable offline How-to page is complete. The following parts remain:

- [ ] Add contextual **Learn about this** links to the session builder, editor, statistics, exam plan, backups and scheduling settings.
- [ ] Open the exact relevant Help question rather than the top of the Help page.
- [ ] Add data-specific **Why?** explanations for due dates, readiness and daily plans.
- [ ] Add an optional first-run **Show me how Recall works** guided tour.
- [ ] Use clearly labelled demo or isolated tutorial data; never silently change real cards or study history.
- [ ] Teach navigation, card creation, preview, study, ratings, Undo, results, exam dates, search and backups in short steps.
- [ ] Provide **Back**, **Next**, **Skip**, progress, resume and restart controls.
- [ ] Remember completion or dismissal locally without repeatedly prompting the user.
- [ ] Make the tour keyboard/screen-reader friendly and safe at 200% zoom, on mobile, in dark mode and with reduced motion.

### 5. Actionable weak-card inbox

- [ ] Add a **Cards to improve** view based on repeated recent Bad/Good Scheduled review ratings.
- [ ] Explain why each card appears.
- [ ] Allow selected cards to be studied, edited, moved or suspended.
- [ ] Link weak sections and session results directly to the relevant card list.
- [ ] Keep the rule simple and visible; never describe confidence ratings as exam scores or mastery.

### 6. Per-card history and schedule explanation

- [ ] Show scheduled-review dates, ratings, interval changes, lapses and Undo events for each card.
- [ ] Explain the current due date in one sentence using the actual interval rule applied.
- [ ] Explain when an exam date capped the next review.
- [ ] Clearly separate Scheduled review events from Practice and Test once attempts.
- [ ] Provide a direct **Edit card** action while preserving the user's return location.

### 7. Seven-day workload preview

- [x] Show scheduled reviews and planned new cards for each of the next seven days, grouped by course.
- [x] Call it the **current plan**, not a guaranteed prediction, because future ratings change later dates.
- [x] Highlight unusually heavy days with restrained semantic styling.
- [x] Allow studying some cards early and explain how counts will change.
- [x] Keep the exam buffer and reviews-before-exam rules consistent with the daily planner.

### 8. Command palette and shortcut help

- [ ] Add a `Cmd/Ctrl+K` command palette for navigation and common actions.
- [ ] Include courses, sections, New card, Start session, Resume session and Settings.
- [ ] Add a `?` shortcut overlay grouped into global, editor and study shortcuts.
- [ ] Keep `/` focused on card search unless user testing shows a merged search is clearer.

### 9. More reversible actions

- [x] Add transactional Undo for moving, tagging, suspending, unsuspending and reordering cards where safe.
- [x] Use the existing toast pattern and state the exact affected count and destination.
- [x] Keep permanent-deletion confirmation and edit-conflict protection.

### 10. Better session completion

- [ ] Offer relevant result actions such as **Review difficult cards**, **Edit weak cards**, **Continue with another 10** and **Done for today**.
- [ ] Explain whether a follow-up is Scheduled review or schedule-neutral Practice.
- [ ] Do not encourage unnecessary studying when the user is already caught up.

### 11. Backup confidence

- [ ] Show the last successful automatic snapshot and last exported full backup.
- [ ] Explain that same-disk snapshots do not protect against losing the computer.
- [ ] Offer an optional, dismissible reminder when no full backup has been exported recently.
- [ ] Provide a direct **Export full backup** action without claiming Recall knows where the file was copied.

### 12. Accessibility and mobile polish

- [ ] Complete a manual keyboard, screen-reader, zoom, contrast and touch-target pass for every primary workflow.
- [ ] Ensure dynamic status and error messages are announced without stealing focus.
- [ ] Aim for 44px frequent-action targets on touch layouts and satisfy WCAG 2.2 minimum target sizing/spacing.
- [ ] Verify all workflows at 200% zoom and narrow widths without overflow or obscured focus.
- [ ] Preserve visible focus, logical focus order, reduced motion and non-colour indicators.
- [ ] Add useful automated accessibility checks while keeping manual checks in the release checklist.

## Larger features for later

- [ ] Cloze deletion with multiple deletions and a clear preview
- [ ] Reversible front/back cards with separate scheduling state where appropriate
- [ ] Image occlusion that remains fully local and is included in media backups
- [ ] Reusable card templates with explicit fields and safe template evolution
- [ ] Manually authored multiple-choice cards
- [ ] Deck/card printing
- [ ] Cleanup tool for unreferenced media files without breaking restorable snapshots

## Product boundaries

Do not add AI-generated content, cloud accounts, telemetry, social features, XP, mascots, badges, confetti or predicted exam scores. Avoid charts that do not answer a concrete question and lead to an action. Do not replace the transparent scheduler with a black box merely to advertise a more sophisticated algorithm.

## Definition of done for future work

1. Update shared types, migrations, backup/import behavior and documentation when the data model changes.
2. Add focused unit/API tests and extend the browser walkthrough for changed primary screens.
3. Test empty, loading, error, stale-tab, keyboard, mobile and dark-mode states.
4. Run `npm test`, `npm run build` and `node scripts/screenshots.ts` when screens change.
5. Commit each change independently using the existing conventional commit style.
