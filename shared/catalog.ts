/** Restrained course colour palette (names map to design tokens in the client). */
export const COURSE_COLORS = [
  'indigo',
  'blue',
  'sky',
  'teal',
  'emerald',
  'lime',
  'amber',
  'orange',
  'rose',
  'fuchsia',
  'violet',
  'slate',
] as const;
export type CourseColor = (typeof COURSE_COLORS)[number];

/** Course icons (lucide names, bundled locally). */
export const COURSE_ICONS = [
  'book-open',
  'graduation-cap',
  'brain',
  'cpu',
  'camera',
  'eye',
  'scan',
  'sigma',
  'calculator',
  'network',
  'database',
  'code',
  'binary',
  'flask',
  'atom',
  'globe',
  'layers',
  'chart',
  'shield',
  'pen',
] as const;
export type CourseIcon = (typeof COURSE_ICONS)[number];

export const SECTION_KINDS = [
  { value: 'lecture', label: 'Lecture' },
  { value: 'tutorial', label: 'Tutorial' },
  { value: 'revision', label: 'Exam revision' },
  { value: 'reading', label: 'Reading' },
  { value: 'other', label: 'Other' },
] as const;
