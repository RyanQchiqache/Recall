# Handoff: next work on Recall

Work through the parts in order. Recall is a local, offline, single-user flashcard app: a Fastify + SQLite server in `server/`, a React frontend in `src/`, and shared types in `shared/`. Read `README.md`, `PRODUCT.md` and `DESIGN.md` before changing the UI.

## Ground rules

- Other coding sessions sometimes edit this repo at the same time. Check for active agents before starting, and don't edit files another session is working on.
- Use Node 24. If `node -v` is not 24, run `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
- Git has no identity configured. Commit with `git -c user.name=r.qchiqache -c user.email=r.qchiqache@reply.de commit ...`.
- Make one commit per change, using the existing message style (`fix(scope): ...`, `feat(scope): ...`).
- The user is short on tokens. Read only what you need, and don't explore the whole codebase.

## Part 0: Commit the fixes already in the working tree

These changes are finished and typecheck clean, but they are not committed yet. Run `npm run typecheck`, then commit them as separate commits:

1. `src/pages/StudyScreen.tsx`: the idempotency key now includes the session revision. Before, rating a card again after Undo was ignored.
2. `src/main.tsx`: the course, section, study and results pages are keyed by `:id`, so state no longer leaks between items.
3. `src/lib/queries.ts`: `invalidateContent` also refreshes the `session` and `results` queries.
4. `src/pages/CardEditor.tsx` and `src/components/TagInput.tsx`: drafts are now handled safely.
   - The draft key is stable, and a pending draft is saved when the user leaves the page or on `pagehide`.
   - A restored stale draft keeps its base revision, so saving raises the conflict dialog. "Load their version" deletes the draft.
   - Tag text the user hasn't confirmed yet is included on save.
   - Enter in the tag field never submits the form, and save shortcuts are ignored while a dialog is open.

## Part 1: Bug fixes

1. **Onboarding: the first-run wizard disappears after step 1.** The Dashboard switches away from the wizard as soon as `hasContent` becomes true. Keep the wizard's progress in `sessionStorage` so it stays open until the user finishes or skips it.
2. **Dashboard streak tile ignores "Show study streak".** It ignores `settings.showStreak`, and it calls `useStats` only to get the streak. Respect the setting, and return the streak from the dashboard API instead.
3. **The statistics page breaks on an invalid date range.** An invalid custom range replaces the whole page with an error. Validate the range on the client and show the error inline next to the date fields.
4. **Smaller fixes:**
   - Dashboard semester select: add a try/catch, and keep the option visible when the current semester is archived.
   - SessionBuilder: show preview errors, and use one seed for both the preview and the created session.
   - CoursePage section reorder: swap with the visible neighbour, not with a hidden archived section.
   - Delete dialog: if loading the "what will be deleted" summary fails, show the error with a Retry button.
   - Mobile drawer: close it with Escape, move focus into it when it opens, and return focus to the menu button when it closes.
   - SectionPage: disable "Study section" properly when the section has 0 cards.

## Part 2: Reorder cards inside a section

This was in the original brief but is missing from the app. Add an API endpoint to change a card's position within its section, and up/down buttons on the section page. Keep the order stable after reloads, exports and imports.

## Part 3: Exam planning (new feature)

The goal is to set an exam date for a course and have Recall tell the user each day how many cards to learn and how many to revise, so they are fully prepared by the exam. It should also show how prepared they are right now.

### Step 1: exam date, daily plan, readiness

- **Exam date per course.** Add an optional exam date in the course settings, for example "Algorithms: exam on 15 Dec". Store it in the database with a migration, and allow the user to clear it.
- **Daily plan on the dashboard.** Show it for each course that has an upcoming exam.
  - **Learn today:** the course's new cards, spread evenly over the days left. Finish learning new cards a few days before the exam (default 3 buffer days, or fewer when the exam is close) so the last days are review only.
  - **Revise today:** the cards that are due for review.
  - **Catching up:** if the user skips a day, recalculate from today. The plan always works from what is left, so the next day's numbers go up automatically.
  - Each plan row has a button that starts a study session with exactly those cards. Reuse the existing session builder rather than building a new study flow.
- **Readiness.** Show it per course, for example "62% learned · 48% solid", plus an "On track" or "Behind by N cards" status.
  - *Learned* means the card has been studied at least once.
  - *Solid* means the card's recent ratings are good. Base this on the existing scheduling state, and pick a simple rule you can explain in one sentence in the UI.
  - **Wording:** the app never presents self-ratings as exam scores or "mastery" (see `README.md`, the line about ratings being personal confidence judgements). Use plain words like "learned" and "answering well". Never write "you'll score X%" or "mastery".
- Show nothing extra for courses without an exam date. Once an exam date has passed, show "Exam passed" with an option to clear the date.

### Step 2: reviews land before the exam

Change the scheduler so that, for a course with an upcoming exam, no review interval goes past the exam date. Cap the next due date at the day before the exam, so every card gets a final review in time. Courses without an exam date must keep the current behaviour. Add tests for both cases.

After both steps, update `README.md`. Exam planning is currently listed there as a possible later addition, so move it into the feature list.

## Finishing

After each part:

1. Run `npm test` and `npm run build`.
2. Check the changed screens in the browser with the `run` skill.
3. Commit.

At the end, run `node scripts/screenshots.ts` to refresh the README screenshots, and commit them separately.

Recall.app (in `/Applications`) starts the app with `node server/index.ts` on port 4317. It rebuilds automatically when the source is newer than `dist/`.

## Future development: UX roadmap

Parts 0–3 above are complete as of 14 October 2026. Do not redo them. The production build and automated suite pass, and `fix(server): serve assets added by rebuilds` (`c985d79`) also fixes the blank screen that previously appeared when frontend assets changed while the server was running.

The next phase should reduce friction rather than add configuration. Preserve Recall's existing product principles: local and offline, no accounts or telemetry, transparent scheduling, confidence-based wording, keyboard-first operation, calm presentation, and motivation from real data instead of gamification.

Work through the following priorities in order. Treat each numbered item as its own designed, tested and committed change.

### 1. Reliable application startup

Replace the opaque browser-launch experience with a clear startup flow. Recall must never leave the user looking at an unexplained blank page.

- Show a small startup/status experience with plain-language stages such as **Starting Recall**, **Rebuilding after an update**, and **Opening Recall**.
- Detect and restart a stale or unhealthy local server automatically, including the case where the HTML references JavaScript or CSS that the server cannot serve correctly.
- If startup or rebuilding fails, show the actual actionable error with **Retry**, **Open log**, and **Copy details** actions.
- Do not open the main page until the health endpoint and current frontend assets are ready.
- Make repeated launches safe: focus/open the existing instance rather than starting competing servers.
- Keep Node/version, port-in-use and missing-build failures understandable to a non-developer.
- Add automated coverage for fresh launch, already-running launch, rebuild, stale assets, port conflict and failed build.

### 2. One-click “Study today”

Make the recommended daily session the easiest path while keeping the full session builder available.

- Put one primary dashboard action such as **Study today · 18 cards · about 12 minutes** above the configurable flow.
- Combine cards currently due with today's exam-plan new-card allowance. Never include more or different cards than the summary promises.
- If a session is already open, **Resume session** remains the primary action.
- Put **Customize session** beside or below the recommendation and reuse the existing session builder.
- Estimate duration from the user's recent local study time per attempted card. Label the estimate clearly as approximate and omit it when there is not enough history.
- Handle zero-card, all-caught-up, multiple-exam and overdue-plan states explicitly.

### 3. Global quick-add card

Allow card capture without navigating through the hierarchy first.

- Add a globally available **New card** action and a keyboard shortcut such as `N`, ignored while typing or while a dialog is open.
- Default to the most recently used active section, while making the destination easy to change.
- Preserve the page the user came from and return there after a normal save.
- Keep **Save & add another** for rapid capture.
- Warn about likely duplicates in the selected section before saving, without blocking intentional duplicates.
- Reuse the existing draft, conflict, pending-tag, image and Markdown behavior rather than creating a second editor implementation.
- Show the shortcut in a tooltip and in the shortcut reference described below.

### 4. “How to use Recall” and interactive guided tour

Add a permanent, fully offline learning area for new and returning users. It should combine searchable documentation, question-and-answer explanations for every option, contextual help, and an optional interactive walkthrough of the real interface.

#### How-to area

- Add **How to use Recall** to the main navigation or another consistently visible Help location. It must remain available after onboarding is completed.
- Organize it around user goals instead of code structure: **Set up your library**, **Create cards**, **Study**, **Understand ratings**, **Plan for an exam**, **Read statistics**, **Manage and find cards**, **Back up or move data**, **Settings**, and **Keyboard shortcuts**.
- Start each topic with a short plain-language overview, then provide step-by-step instructions, examples and links that take the user directly to the relevant screen.
- Include a searchable question-and-answer reference covering every visible option and setting. Use questions a user would naturally ask, for example:
  - **What is the difference between Scheduled review, Practice and Test once?**
  - **What happens when I choose Bad, Good, Very good or Perfect?**
  - **Does Practice change the next review date?**
  - **What does “Include new cards” do?**
  - **Why is this card due today?**
  - **How are Learn today, Revise today and readiness calculated?**
  - **What do session size, order, filters and maximum attempts change?**
  - **What is saved in a snapshot, full backup, course package or CSV export?**
  - **Where is my data stored and what remains fully local?**
- Explain consequences before instructions where they matter, especially for scheduling, restore/import, deletion, suspension and exam planning.
- Keep terminology identical to the interface and update the relevant help entry whenever an option or label changes.
- Ship all help text, illustrations and examples with the app. Do not require internet access or link to remote content for essential instructions.

#### Contextual help

- Add small **Learn about this** links or help buttons on complex screens such as the session builder, card editor, statistics, exam planning, backups and scheduling settings.
- Open the exact relevant question or topic rather than sending every link to the top of the help area.
- Keep help visually secondary and avoid filling normal workflows with permanent explanatory text.
- Add **Why?** explanations beside calculated values such as due dates, readiness and daily plans when the explanation can be specific to the user's data.

#### Interactive guided tour

- Offer **Show me how Recall works** during first-run onboarding, alongside clear **Skip for now** and **Do it myself** choices.
- Let users restart the tour at any time from **How to use Recall** or Settings.
- Teach through short, optional tasks in the actual interface: navigate the hierarchy, create or inspect a card, preview Markdown, start a small session, reveal an answer, use the four ratings, Undo a rating, read results, set an exam date, find a card, and locate backup controls.
- Use the clearly labelled demo course or isolated tutorial data. Never silently modify, rate, move or delete the user's real cards.
- State whether each tutorial action is simulated, affects demo data, or affects real data before it happens.
- Use focused callouts attached to the real control, one instruction at a time, with **Back**, **Next**, **Skip tour**, progress such as **3 of 8**, and a way to resume an interrupted tour.
- Do not trap the user in the tour. Normal Escape behavior, browser navigation and closing/reopening Recall must remain safe.
- Finish with a concise checklist and direct next actions such as **Create my first course**, **Add a card**, **Start a session**, or **Explore demo content**.
- Remember completion and dismissal locally. Do not repeatedly prompt users who skipped or completed the tour.

#### Accessibility and maintenance

- The tour and help area must work with keyboard-only navigation, screen readers, 200% zoom, mobile layouts, dark mode and reduced motion.
- Move focus to each newly explained control without obscuring it, and return focus predictably when a topic or tour is closed.
- Do not rely on animation, position or colour alone to identify the current control.
- Add tests that every contextual-help target resolves to an existing topic, every documented option still exists, and completing or skipping the tour cannot alter real study history.
- Extend the screenshot walkthrough with the help landing page, a question-and-answer topic, the first tour step, a mid-tour step and the completion state.

### 5. Actionable weak-card inbox

Statistics already identifies weak sections; add a direct path from insight to action.

- Add a **Cards to improve** view based on repeated recent Bad/Good scheduled-review ratings.
- Explain why each card appears, for example **Good on the last 3 scheduled reviews**.
- Allow the user to study selected cards, edit them, move them, suspend them, or remove them from the list by improving their recent result.
- Offer helpful neutral actions such as **Edit card**, **Split this card**, and **Suspend**, without claiming the card is objectively bad or that a rating is an exam score.
- Link weak-section statistics and session results directly to the filtered card list.
- Keep the rule simple, visible and covered by tests.

### 6. Per-card review history and schedule explanation

Make the transparent scheduler understandable at the point where users need it.

- Add a card detail/history panel showing scheduled-review dates, ratings, interval changes, lapses and Undo events.
- Explain the current due date in one sentence, for example: **Rated Very good on 14 October. The interval increased from 4 to 8 days, so this card is due 22 October.**
- When exam capping applies, say so explicitly: **Moved to 19 October so this review happens before the exam.**
- Clearly separate scheduled reviews, practice and test-once attempts because only scheduled reviews change the long-term schedule.
- Provide a direct **Edit card** action and preserve the user's return location.
- Do not use “mastery”, predicted scores or unsupported memory claims.

### 7. Seven-day workload preview

Extend the exam plan from “today” to a small, actionable view of the coming week.

- Show scheduled reviews and planned new cards for each of the next seven days, grouped by course.
- Label it as the **current plan**, not a guaranteed prediction; future ratings will change later due dates.
- Highlight unusually heavy days using restrained semantic styling.
- Allow studying some cards early, while making clear how that affects today's and future counts.
- Recalculate from the remaining work whenever the date, card set, exam date or schedule changes.
- Ensure an exam buffer and reviews-before-exam rules remain consistent with the existing planner.

### 8. Command palette and shortcut help

Support fast keyboard operation without requiring users to memorize the interface.

- Add a `Cmd/Ctrl+K` command palette for navigation, finding courses/sections, creating a card, starting a session, resuming the open session, and opening settings.
- Add a `?` shortcut-reference overlay grouped by context: global, editor and study.
- Search commands and destinations by familiar user-facing names, not internal terminology.
- Hide or disable commands that are unavailable and explain why when that is useful.
- Keep `/` focused on card search unless user testing shows that merging it with the command palette is clearer.

### 9. More reversible actions

Reduce anxiety around organization and bulk editing.

- Add Undo to moving, tagging, suspending, unsuspending and reordering cards where technically safe.
- Use the existing toast pattern and state the exact affected count and destination.
- Keep permanent deletion confirmations and conflict protection.
- Make Undo transactional so partial reversal cannot leave hierarchy or ordering inconsistent.

### 10. More useful session completion

Turn results into a clear next decision instead of a dead end.

- Offer context-dependent actions such as **Review difficult cards**, **Edit weak cards**, **Continue with another 10**, and **Done for today**.
- Do not encourage unnecessary studying when the user is caught up.
- Explain whether the proposed follow-up is scheduled review or schedule-neutral practice.
- Preserve the distinction between first-attempt recall and completion after repeats.

### 11. Backup confidence

Make local data safety visible without creating alarm fatigue.

- Show the date of the last successful automatic snapshot and the last exported full backup.
- Explain that same-disk snapshots do not protect against loss of the computer.
- Offer an optional, dismissible reminder when no full backup has been exported recently.
- Provide one direct **Export full backup** action from the reminder.
- Never imply that Recall verified the exported file was copied to another device.

### 12. Accessibility and mobile polish

Run a dedicated keyboard, screen-reader, zoom, contrast and touch-target pass across every primary workflow.

- Preserve visible focus and logical focus order, including dialogs, drawers, menus, charts and dynamically inserted errors.
- Ensure status updates and save/error messages are announced without stealing focus.
- On touch layouts, aim for 44px frequent-action targets; never fall below the WCAG 2.2 minimum target-size/spacing requirements.
- Verify the complete workflow at 200% browser zoom and narrow viewports without horizontal scrolling or obscured focused controls.
- Respect reduced motion and do not rely on colour alone for rating, warning or selection state.
- Add automated accessibility checks where useful, but retain manual keyboard and screen-reader checks in the release checklist.
- Reference: <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum> and <https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance>.

### Larger features for later

Only begin these after the workflow improvements above are stable. Each card type needs its own editor, study presentation, import/export representation, scheduling state, backup migration and accessibility coverage.

1. **Cloze deletion** with multiple deletions and a clear preview.
2. **Reversible front/back cards** with independent scheduling where appropriate.
3. **Image occlusion** that remains fully local and works with existing media backups.
4. **Reusable card templates** with explicit fields and safe template evolution.

### Product boundaries

Do not add AI-generated content, cloud accounts, telemetry, social features, XP, mascots, badges, confetti or predicted exam scores. Avoid additional charts unless they answer a concrete question and lead to an action. Do not replace the transparent scheduler with a black box merely to advertise a more sophisticated algorithm.

### Definition of done for future UX work

For every item above:

1. Update shared types, migrations, backup/import behavior and documentation when the data model changes.
2. Add focused unit/API tests and extend the Playwright screenshot walkthrough for changed primary screens.
3. Test empty, loading, error, stale-tab, keyboard, mobile and dark-mode states.
4. Run `npm test`, `npm run build`, and `node scripts/screenshots.ts` when screens change.
5. Commit each independently using the existing conventional commit style.
