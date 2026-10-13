# Recall — implementation checklist

Brief: `FLASHCARD_APP_BRIEF.md` (as provided in chat). Status as of 2026-10-13.

## Environment
- Node 24 LTS installed via Homebrew (keg-only): `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`
- Server runs TypeScript directly with Node's native type stripping (no server build step).
- Run tests: `npx vitest run`. Typecheck: `npm run typecheck`.

## Done
- [x] git repo initialised (`main`), nothing committed yet
- [x] package.json, lockfile, tsconfig (client + server), vite/vitest config, .gitignore
- [x] shared/: dates (tz/DST-safe calendar math), ratings, scheduler (recall-heuristic-v1), queue (repeat gaps, cap, relax), seeded RNG, settings, DTO types, catalog
- [x] server/: config (loopback-only, data dir), SQLite + migrations (FTS5, views), Fastify app (host check, origin/CSRF checks, CSP, media serving, SPA fallback), routes
- [x] services: hierarchy (CRUD, archive, trash, reorder, move, duplicate, impact), cards (CRUD, FTS search, tags, bulk), media (magic-byte validation), drafts, sessions (selection, queue persistence, rating + scheduling, undo, idempotency, pause/resume, results), stats + dashboard, backup (full/course ZIP, validated restore via scratch DB, SQLite snapshots + retention), CSV import/export, demo course (generated PNG)
- [x] tests: 56 passing (dates/DST, scheduler, queue, sessions, undo/idempotency, restart/resume, backup round-trip, CSV, security, trash, demo)

## Next (frontend, src/)
- [ ] index.css design tokens (light/dark), fonts, KaTeX, code highlighting styles
- [ ] main.tsx, router, api client (sends `X-Recall-Client: 1`), react-query hooks, toasts
- [ ] UI primitives (Button, Field, Dialog via radix-ui, Menu, Tooltip, Badge, EmptyState)
- [ ] AppShell: 250px sidebar with collapsible hierarchy, mobile drawer, breadcrumbs
- [ ] Pages: Dashboard + onboarding, Organizer, Course, Section, Card editor (live preview, drafts, paste/drop images), Session builder, Study screen (keys 1–4/Space/H/U/Esc, rating intro), Results, Stats, Settings & backups, Trash, Search, CSV import dialog
- [ ] Markdown renderer: remark-gfm/math, rehype-katex, rehype-highlight, skipHtml, block non-/media/ images
- [ ] `npm run build`, start, Playwright screenshots at 1440px and 390px, offline/no third-party request check
- [ ] README (install, start, data location, backup/restore, troubleshooting, architecture)
