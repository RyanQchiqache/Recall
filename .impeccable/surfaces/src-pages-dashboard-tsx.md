---
version: 1
slug: "src-pages-dashboard-tsx"
primary_target: "src/pages/Dashboard.tsx"
related_targets: ["src/components/layout/AppShell.tsx","src/pages/StudyScreen.tsx","src/index.css"]
---

# Surface brief: Recall app shell + dashboard (whole-app restyle)

Scope: every app screen (shell, dashboard, study, builder, course/section, stats, settings). Mode: Operate. Audience/job: one university student at a desk, starting and finishing study sessions daily; wants to feel progress. Constraints: no new features, offline only, real data only.

## Direction contract
THESIS: Recall as the best-executed modern study app: a familiar Linear-grade workspace where today's work and real progress are readable at a glance. Refuses the indigo-on-cream soft-card look of the incumbent and any gamified chrome.
OWN-WORLD: White sidebar on a #f5f6f8 ground, #111827 ink, one blue accent #2563eb for primary actions, selection and due counts only. Inter with tabular figures, 1px #e5e7eb hairlines, 8–12px radii, near-flat shadows. Rating colours (red/amber/blue/green) appear only where ratings are shown.
STORY: The student opens Recall, sees how many cards are due, their streak and each course's on-track share, and starts a session in one click; after studying, the on-track bars and streak visibly move.
FIRST VIEWPORT: Sidebar (logo, search field with "/" hint, nav with Study due count, library tree, "Saved locally" footer). Main: greeting + date left, Create course + primary Start session right; three stat tiles (Due today, New cards, Streak with 14-day bars); a two-column grid of course cards each with due/new/cards figures, an on-track progress bar and a Study button (primary when cards are due).
FORM: Category standard (canon), user-chosen; craft bar Linear; seed key 3bedaa25.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
