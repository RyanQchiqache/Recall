# Recall — implementation checklist

Status as of 2026-10-13. See README.md for setup and usage.

## Done
- [x] Local app/API/SQLite, migrations, full hierarchy CRUD, archive, trash, reorder, move, duplicate, responsive navigation
- [x] Card editor: Markdown + KaTeX + highlighted code + local images (upload/paste/drop), live preview, server-side drafts, tags, hint, source, explanation, save & add next, edit-conflict handling
- [x] Search (FTS5 + substring), filters, bulk move/tag/bookmark/suspend/delete
- [x] Session builder (scope, mode, size presets/custom, ordering, filters, smaller-pool handling), study screen (reveal, 4 ratings + keys, repeat queue, relax prompt, attempt cap, undo, pause/resume/exit, rating guide), results
- [x] Scheduler v1 with settings snapshot per session; DST-safe calendar dates
- [x] Statistics (by mode, first-attempt vs after repeats, weak sections, heatmap/streak hideable)
- [x] Full backup ZIP export/restore (validated in scratch DB, pre-restore snapshot), course packages, CSV import/export, SQLite snapshots with retention, demo content
- [x] Security: loopback-only bind, Host/Origin/custom-header checks, CSP, upload validation, sanitized Markdown
- [x] Tests: 66 passing (Vitest). Typecheck clean. Production build OK.
- [x] Browser walkthrough (scripts/screenshots.ts): 26 screens, 1440px + 390px, light + dark, keyboard study, reload resume — no overflow, console errors or third-party requests

## Possible later improvements (not started, non-AI)
- Manually authored cloze and multiple-choice cards, image occlusion, exam-date planning, deck printing
- Reversible front/back cards with separate scheduling state per direction
- Cleanup tool for unreferenced media files
