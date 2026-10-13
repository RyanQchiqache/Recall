---
name: Recall
description: A private, offline flashcard workspace for one university student, built to the category standard at Linear-grade craft.
colors:
  primary: "#2563eb"
  primary-hover: "#1d4ed8"
  primary-soft: "#eef3fe"
  primary-text: "#1d4ed8"
  on-primary: "#ffffff"
  focus: "#3b82f6"
  bg: "#f5f6f8"
  surface: "#ffffff"
  surface-2: "#f3f4f6"
  surface-3: "#e8eaee"
  border: "#e5e7eb"
  border-strong: "#d1d5db"
  text: "#111827"
  text-2: "#374151"
  muted: "#6b7280"
  danger: "#dc2626"
  danger-soft: "#fef2f2"
  success: "#15803d"
  success-soft: "#ecfdf3"
  warning: "#b45309"
  warning-soft: "#fffbeb"
  rating-bad: "#dc2626"
  rating-good: "#d97706"
  rating-verygood: "#2563eb"
  rating-perfect: "#16a34a"
  code-bg: "#f6f7f9"
  dark-bg: "#0e0f12"
  dark-surface: "#16171b"
  dark-surface-2: "#1c1d22"
  dark-border: "#26282e"
  dark-text: "#ececef"
  dark-muted: "#8e9199"
  dark-primary: "#3b82f6"
  dark-primary-text: "#8db4ff"
typography:
  display:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontFeature: "'tnum'"
  title:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.375
    letterSpacing: "-0.01em"
  reading:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 400
    lineHeight: 1.625
  body:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "'cv11', 'ss01'"
  label:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: "JetBrains Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  swatch: "3px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  2xl: "16px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  page-gutter: "48px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.lg}"
    padding: "0 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "0 14px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-2}"
  button-ghost:
    textColor: "{colors.text-2}"
    rounded: "{rounded.lg}"
    padding: "0 14px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.lg}"
    height: "36px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "0 12px"
    height: "36px"
  nav-item:
    textColor: "{colors.text-2}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  nav-item-active:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary-text}"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "20px"
  badge:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-2}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  rating-button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "12px 14px"
    height: "72px"
  study-card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.2xl}"
    padding: "32px"
  kbd:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.muted}"
    typography: "{typography.mono}"
    rounded: "5px"
    padding: "0 6px"
  tooltip:
    backgroundColor: "{colors.text}"
    textColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "6px 10px"
---

# Design System: Recall

## Overview

**Creative North Star: "The Quiet Workbench"**

Recall is the category standard for a study app, played straight and executed at Linear-grade precision. It is a neutral workspace: a white sidebar on a cool grey ground, near-black ink, one blue accent, 1px hairlines and near-flat surfaces. Nothing in the chrome performs. The loudest thing on any screen is either the number that tells the student what to do next (cards due, streak) or, on the study screen, the card itself with its math and code.

Density is desk density: 15px body, 13px labels, 32–36px controls, tabular figures everywhere a number can move. Hierarchy comes from weight (500/600), size steps and the ink ramp (text, text-2, muted), not from colour or decoration. The keyboard is a first-class surface: shortcut keycaps sit inline next to the actions they trigger.

Two families of colour sit outside the neutral-plus-blue core and are fenced in. Rating colours (red, amber, blue, green) appear only where a rating is shown. Course colours are user data: a small square swatch or a tinted icon tile that identifies a course, never a fill for chrome. Light and dark themes are both complete token sets, not inversions.

**Key Characteristics:**
- Neutral grey ground, white surfaces, one blue accent.
- 1px hairline borders do the structural work; shadows are barely there at rest.
- Inter with tabular numerals; weights 400/500/600 only.
- 8–12px radii on controls and panels, 16px on the study card alone.
- Keyboard hints rendered as mono keycaps beside their actions.
- Motivation from real data (counts, streak bars, on-track bars), never from badges or celebration.

## Colors

A cool-neutral grey workspace carried by a single saturated blue, with semantic and rating colours appearing only where they carry meaning.

### Primary
- **Workbench Blue** (primary): the primary action on a screen (Start session, Study when cards are due, Resume session), active selection, the activity and on-track bars, and the logo tile. Hover deepens to **Pressed Blue** (primary-hover).
- **Wash Blue** (primary-soft): the active nav row and active tree item background, the info alert, the primary badge tone.
- **Ink Blue** (primary-text): text-weight blue on light grounds: due counts, active nav labels, inline links, toast actions. Used instead of primary wherever blue is text, for AA contrast.
- **Focus Blue** (focus): the 2px focus-visible outline, offset 2px.

### Neutral
- **Cool Ground** (bg): the page background behind everything.
- **Paper White** (surface): sidebar, panels, cards, inputs, dialogs, menus.
- **Soft Fill** (surface-2) and **Deep Fill** (surface-3): hover fills, segmented-control track, keycaps, empty progress tracks, the explanation block on the study card.
- **Hairline** (border) and **Firm Hairline** (border-strong): every structural divider and outline; border-strong is the hover state of outlined controls and cards.
- **Ink** (text), **Graphite** (text-2), **Slate** (muted): the three-step ink ramp for primary text, secondary text and labels/meta.

### Semantic
- **Danger / Success / Warning** with their soft washes: alerts, badges, destructive buttons, exam-date warnings (exam within 14 days uses warning-soft), the green "Saved locally" dot.

### Rating
- **Bad** (rating-bad), **Good** (rating-good), **Very good** (rating-verygood), **Perfect** (rating-perfect): rating buttons, rating badges, rating distributions in charts.

### Dark theme
The `.dark` set re-tunes every role rather than inverting: near-black ground (dark-bg), lifted greys for surfaces (dark-surface, dark-surface-2), a slightly lighter blue (dark-primary) with a pale blue for blue text (dark-primary-text), and lighter semantic and rating hues. All dark values live in `src/index.css` under `.dark`.

### Named Rules
**The One Blue Rule.** Blue is reserved for primary actions, selection, due counts and progress. If it is not one of those, it is grey.

**The Rating Fence Rule.** The four rating colours appear only where a rating is shown or rated. Never borrow amber for a warning or green for success from the rating set; use the semantic tokens.

**The Course Swatch Rule.** Course colours identify a course through an 8–10px square swatch (3px radius) or a 15% tinted icon tile. They never fill buttons, headers or backgrounds.

## Typography

**Display Font:** Inter Variable (with ui-sans-serif, system-ui)
**Body Font:** Inter Variable
**Label/Mono Font:** JetBrains Mono Variable (keycaps, code, the Markdown editor)

**Character:** One neutral grotesque at three weights, tuned with `cv11` and `ss01` and tabular figures, so the interface reads as precise rather than styled. Mono is functional only: code and keys.

### Hierarchy
- **Display** (600, 28px / 26px under 640px, 1.25, -0.02em): page titles and the dashboard greeting. One per page.
- **Headline** (600, 22–26px, leading 1, -0.01 to -0.02em, tabular): stat values and course-card figures. Numbers, not words.
- **Title** (600, 15px, -0.01em): section titles, card titles, nav-level headings. Dialog titles step up to 18px.
- **Reading** (400, 19–20px question / 17px answer, 1.625): Markdown on the study card and the editor preview, the only text larger than body that is not a number.
- **Body** (400, 15px, 1.55): default text; controls use 14px (text-sm), compact controls 13px.
- **Label** (500, 13px, muted): stat labels, field hints, meta lines, sidebar group labels. Sentence case.
- **Mono** (11px keycaps; 0.86em inline code; 14px in the Markdown editor).

### Named Rules
**The Tabular Rule.** Every count, percentage and duration uses tabular figures so values do not jitter as they change.

**The Three Weights Rule.** 400, 500 and 600 only (650 inside rendered Markdown headings and strong). No bold 700 in the chrome.

## Layout

A fixed 248px white sidebar on the left (from 1024px up) and a main column capped at 1160px, padded 48px horizontally on desktop, 24px on tablet and 16px on mobile, with 40px top padding on desktop. Below 1024px the sidebar becomes a 300px slide-in drawer (max 85vw) behind a 56px sticky top bar with a translucent surface and backdrop blur.

The spacing rhythm is a 4px base: 8px and 12px gaps between sibling panels, 16–20px inside panels, 24–28px between page sections (page headers carry 28px bottom margin). The dashboard opens with three stat tiles in a fixed three-column grid (8px gap on mobile, 12px from 640px), then a two-column course grid from 768px. The study screen is a single centred column with the card and the four rating buttons (2 columns on mobile, 4 from 640px).

## Elevation & Depth

Near-flat. Depth comes from the grey ground against white surfaces plus 1px hairlines; shadows are whisper-level at rest and only real on floating layers (dialogs, menus, toasts, tooltips, the mobile drawer). Exact shadow values for both themes are in the sidecar.

### Shadow Vocabulary
- **Soft** (shadow-sm: a single 1px, 4%-ink shadow): resting outlined controls, panels, inputs, rating buttons.
- **Card** (shadow: soft plus a 2px/8px 4% layer): course-card hover and the study card.
- **Pop** (shadow-lg: 12px/32px 14% plus 2px/6px 6%): dialogs, menus, toasts, tooltips, drawer.
- **Primary bevel**: primary buttons add a 1px inset white highlight at 14% over shadow-sm.

### Named Rules
**The Hairline First Rule.** Structure is drawn with 1px borders, never with shadow. A shadow that is visible at rest on a non-floating element is too strong.

**The Lift-On-Hover Rule.** Interactive cards step from soft to card shadow and from border to border-strong on hover; nothing translates upward. Pressed buttons move down 1px.

## Shapes

Gently rounded and consistent: 6px on nav rows, menu items and small inline chips; 8px on buttons, inputs, alerts and menus; 12px on panels, stat tiles, course cards, dialogs, toasts, rating buttons and icon tiles; 16px only on the study card and the paused panel. Pills (full radius) are for badges, switches and progress tracks. Course swatches are 3px-radius squares, activity bars 2px. Empty states use a dashed border-strong outline.

## Components

### Buttons
Crisp and compact; the only filled colour in the chrome is the primary button.
- **Shape:** 8px radius; heights 32 / 36 / 44px (sm / md / lg) with 12 / 14 / 20px horizontal padding; 500 weight; 8px icon gap.
- **Primary:** blue fill, white label, 1px inset highlight; hover to primary-hover. One per view region.
- **Secondary (default):** white surface, hairline border, soft shadow; hover fills surface-2 and firms the border.
- **Ghost / Subtle:** text-2 on transparent (ghost) or surface-2 fill (subtle), hover one fill step darker.
- **Danger:** danger fill for destructive confirmations only.
- **States:** 150ms colour transitions; active presses down 1px; disabled at 50% opacity. Icon buttons are square (32/36px) and carry a tooltip with their label.

### Chips / Badges
- **Style:** pill, 12px 500 text, 2px 8px padding; neutral (surface-2 with hairline) or a tone (soft wash plus tone text). Rating badges carry their rating icon.
- **Exam chip:** 6px radius, warning tone within 14 days of the exam, neutral otherwise.

### Cards / Containers
- **Corner Style:** 12px (panels), 16px (study card).
- **Background:** surface on the bg ground.
- **Shadow Strategy:** soft at rest, card on hover (see Elevation).
- **Border:** 1px hairline always.
- **Internal Padding:** 16–20px (panels, course cards), 32px on the study card and paused panel.

### Inputs / Fields
- **Style:** 36px height, white surface, hairline border, soft shadow, 8px radius, 14px text, muted placeholder, blue caret.
- **Focus:** border turns primary plus a 3px primary ring at 15% opacity.
- **Error / Disabled:** border turns danger, message in danger 14px below; disabled at 60% opacity.
- **Select:** native select with appearance removed and a 16px muted chevron 12px from the right edge.
- **Segmented control:** surface-2 track with 4px padding; the active segment is a white surface with soft shadow. The card layout variant marks the active option with a primary border on primary-soft.

### Navigation
- **Sidebar:** logo tile and app name, a search field styled as an input with a `/` keycap, nav rows 32px high (6px radius, 14px 500, icon at 80% opacity). Active row is primary-soft with primary-text; hover fills surface-2. The Study row carries the due count in muted tabular figures.
- **Library tree:** 13px rows with rotating chevrons and 1px hairline indent guides; course rows show their swatch and a primary-text due count.
- **Footer:** hairline-topped row with a green status dot, "Saved locally" and a theme toggle.
- **Mobile:** 56px sticky top bar with menu button; the sidebar slides in as a drawer over a 45% ink scrim.

### Keycap
Mono 11px on surface-2 with a hairline border, 5px radius and a 1px bottom border-coloured edge, minimum width 1.4rem. Sits beside the action it triggers (search field, rating buttons, study footer).

### Rating Buttons (signature)
Four outlined 12px-radius tiles, minimum 72px tall: a 20px rating-tinted icon square, the rating name in 14px 600, the key as a keycap at the right, and the meaning in 12px muted text below. Hover tints the border to 55% and the fill to 6% of the rating colour; focus sets the border to the full rating colour. The rating colour never fills the tile.

### Stat Tile and Progress
Stat tiles: a 36px hairline icon square, a 13px muted label, a 26px tabular value with an optional unit, and a 12px muted hint. The streak tile carries 14 activity bars (5px wide, 3px gap, 2px radius; primary when active, surface-3 when empty). Course cards show due/new/cards figures and a 6px pill track: primary for on-track, a 38% primary mix for due, surface-3 for the rest.

## Do's and Don'ts

### Do:
- **Do** keep one primary button per view region; everything else is secondary or ghost.
- **Do** use primary-text, not primary, whenever blue is text.
- **Do** draw structure with 1px hairlines (border) and reserve shadow-lg for floating layers.
- **Do** set every changing number in tabular figures.
- **Do** show keyboard shortcuts as mono keycaps beside their actions.
- **Do** define every new colour in both the `:root` and `.dark` token sets.
- **Do** show progress only from real data: counts, streak, activity bars, on-track bars.

### Don't:
- **Don't** use rating colours outside rating contexts, or semantic colours for ratings.
- **Don't** fill chrome with course colours; a course is identified by its swatch or tinted icon tile.
- **Don't** add mascots, confetti, XP bars, cartoon badges or celebratory gamification.
- **Don't** return to the indigo-on-cream soft-card look this system replaced.
- **Don't** add uppercase tracked labels or eyebrows above headings; labels are 13px sentence case.
- **Don't** use weights above 600 in the interface chrome.
- **Don't** hardcode hex values in components; reference the tokens.
