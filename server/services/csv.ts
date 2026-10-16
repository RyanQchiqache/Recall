import Papa from 'papaparse';
import { z } from 'zod';
import type { CsvPreview, CsvPreviewRow } from '../../shared/types.ts';
import { nowIso, type Ctx } from '../context.ts';
import { badRequest, newId, normalizeForCompare } from '../lib/util.ts';
import { parse, zId } from '../lib/validate.ts';
import { noteProblems } from '../../shared/notes.ts';
import { normalizeTags } from './cards.ts';
import { createNote, noteFields, noteOptions, type NoteRow } from './notes.ts';
import { getRow, itemState } from './hierarchy.ts';

const MAX_CSV_CHARS = 10 * 1024 * 1024;
const MAX_ROWS = 20_000;

export const CSV_FIELDS = ['front', 'back', 'section', 'tags', 'source', 'explanation', 'hint', 'type'] as const;
type Field = (typeof CSV_FIELDS)[number];

const mappingSchema = z.object({
  front: z.number().int().min(0),
  back: z.number().int().min(0),
  section: z.number().int().min(0).nullable().optional(),
  tags: z.number().int().min(0).nullable().optional(),
  source: z.number().int().min(0).nullable().optional(),
  explanation: z.number().int().min(0).nullable().optional(),
  hint: z.number().int().min(0).nullable().optional(),
  type: z.number().int().min(0).nullable().optional(),
});
type Mapping = z.infer<typeof mappingSchema>;

const previewSchema = z.object({
  text: z.string().max(MAX_CSV_CHARS, 'The CSV file is too large (max 10 MB)'),
  courseId: zId,
  hasHeader: z.boolean().default(true),
  mapping: mappingSchema,
  defaultSectionId: zId.nullable().optional(),
  duplicatePolicy: z.enum(['skip', 'import']).default('skip'),
});

function parseRows(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const res = Papa.parse<string[]>(clean, { header: false, skipEmptyLines: 'greedy' });
  const fatal = res.errors.find((e) => e.type === 'Quotes');
  if (fatal) throw badRequest(`CSV parse error on row ${(fatal.row ?? 0) + 1}: ${fatal.message}`);
  if (res.data.length > MAX_ROWS + 1) throw badRequest(`The CSV has more than ${MAX_ROWS} rows`);
  return res.data;
}

/** Undo the spreadsheet-formula escape that our own CSV export applies. */
function unescapeCell(v: string): string {
  return /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v;
}

export function inspectCsv(text: string) {
  if (text.length > MAX_CSV_CHARS) throw badRequest('The CSV file is too large (max 10 MB)');
  const rows = parseRows(text);
  if (rows.length === 0) throw badRequest('The CSV file is empty');
  const headers = rows[0].map((h, i) => (h ?? '').trim() || `Column ${i + 1}`);
  const guess: Partial<Record<Field, number | null>> = {};
  const aliases: Record<Field, string[]> = {
    front: ['front', 'question', 'q', 'prompt', 'term'],
    back: ['back', 'answer', 'a', 'response', 'definition'],
    section: ['section', 'lecture', 'week', 'topic', 'deck'],
    tags: ['tags', 'tag', 'labels'],
    source: ['source', 'reference', 'ref', 'slide'],
    explanation: ['explanation', 'notes', 'extra'],
    hint: ['hint'],
    type: ['type', 'card type', 'kind', 'note type'],
  };
  for (const f of CSV_FIELDS) {
    const idx = headers.findIndex((h) => aliases[f].includes(h.toLowerCase()));
    guess[f] = idx >= 0 ? idx : null;
  }
  if (guess.front === null && headers.length >= 2) guess.front = 0;
  if (guess.back === null && headers.length >= 2) guess.back = 1;
  return { headers, sample: rows.slice(1, 6), totalRows: Math.max(0, rows.length - 1), suggestedMapping: guess };
}

type CsvCardType = 'basic' | 'reverse' | 'cloze';

/** The card-type column: empty means basic. */
function parseType(raw: string): { type: CsvCardType } | { error: string } {
  const v = raw.trim().toLowerCase();
  if (!v || v === 'basic') return { type: 'basic' };
  if (['reverse', 'reversed', 'basic+reverse', 'basic (and reversed card)', 'both'].includes(v)) return { type: 'reverse' };
  if (v === 'cloze') return { type: 'cloze' };
  if (['occlusion', 'image occlusion', 'template'].includes(v)) {
    return { error: `“${raw.trim()}” cards can’t be imported from CSV; move them with a course package instead` };
  }
  return { error: `Unknown card type “${raw.trim()}” (use basic, reverse or cloze)` };
}

/** Comparable content of a note for duplicate detection within a section. */
function dupKey(sectionId: string, type: CsvCardType, front: string, back: string): string {
  return type === 'cloze' ? `${sectionId}|cloze|${normalizeForCompare(front)}` : `${sectionId}|basic|${normalizeForCompare(front)}|${normalizeForCompare(back)}`;
}

interface Plan {
  preview: CsvPreview;
  rows: (CsvPreviewRow & { explanation: string; hint: string; sectionKey: string; cardType: CsvCardType })[];
  sectionIdByKey: Map<string, string>;
}

function plan(ctx: Ctx, input: unknown): Plan & { courseId: string } {
  const data = parse(previewSchema, input);
  getRow(ctx, 'course', data.courseId);
  if (itemState(ctx, 'course', data.courseId).inTrash) throw badRequest('The destination course is in the trash');
  const all = parseRows(data.text);
  const headers = data.hasHeader && all.length ? all[0].map((h, i) => h.trim() || `Column ${i + 1}`) : (all[0] ?? []).map((_, i) => `Column ${i + 1}`);
  const body = data.hasHeader ? all.slice(1) : all;
  const m: Mapping = data.mapping;
  const maxCol = Math.max(...Object.values(m).filter((v): v is number => typeof v === 'number'));
  if (headers.length && maxCol >= headers.length) throw badRequest('The column mapping refers to a column that does not exist');

  const sections = ctx.db
    .prepare('SELECT id, title FROM sections WHERE course_id = ? AND deleted_at IS NULL ORDER BY position')
    .all(data.courseId) as { id: string; title: string }[];
  const sectionIdByKey = new Map(sections.map((s) => [normalizeForCompare(s.title), s.id]));
  let defaultSection: string | null = null;
  if (data.defaultSectionId) {
    const s = sections.find((x) => x.id === data.defaultSectionId);
    if (!s) throw badRequest('The default section must belong to the destination course');
    defaultSection = s.id;
  }

  // Existing content per section for duplicate detection.
  const seen = new Set<string>();
  const existing = ctx.db
    .prepare(
      `SELECT section_id, kind, json_extract(fields_json, '$.front') AS front, json_extract(fields_json, '$.back') AS back,
         json_extract(fields_json, '$.text') AS text
       FROM notes WHERE deleted_at IS NULL AND kind IN ('basic', 'cloze') AND section_id IN (SELECT id FROM sections WHERE course_id = ?)`,
    )
    .all(data.courseId) as { section_id: string; kind: string; front: string | null; back: string | null; text: string | null }[];
  for (const n of existing) {
    seen.add(n.kind === 'cloze' ? dupKey(n.section_id, 'cloze', n.text ?? '', '') : dupKey(n.section_id, 'basic', n.front ?? '', n.back ?? ''));
  }

  const cell = (r: string[], idx: number | null | undefined) => (idx === null || idx === undefined ? '' : unescapeCell(r[idx] ?? ''));
  const toCreate = new Map<string, string>();
  const rows: Plan['rows'] = [];
  body.forEach((r, i) => {
    const front = cell(r, m.front);
    const back = cell(r, m.back);
    const sectionName = cell(r, m.section).trim();
    const tags = normalizeTags(cell(r, m.tags).split(/[;,|]/));
    const source = cell(r, m.source).trim().slice(0, 500);
    const errors: string[] = [];
    const typed = parseType(cell(r, m.type));
    const cardType: CsvCardType = 'type' in typed ? typed.type : 'basic';
    if ('error' in typed) errors.push(typed.error);
    else if (cardType === 'cloze') {
      if (!front.trim()) errors.push('Front is empty (for cloze rows it holds the text with {{c1::…}} gaps)');
      else errors.push(...noteProblems('cloze', { text: front, explanation: '', hint: '', source: '' }));
    } else {
      if (!front.trim()) errors.push('Front is empty');
      if (!back.trim()) errors.push('Back is empty');
    }
    if (front.length > 200_000 || back.length > 200_000) errors.push('Text is too long');
    if (tags.some((t) => t.length > 60)) errors.push('A tag is longer than 60 characters');
    let sectionKey = '';
    if (sectionName) {
      sectionKey = normalizeForCompare(sectionName);
      if (!sectionIdByKey.has(sectionKey) && !toCreate.has(sectionKey)) toCreate.set(sectionKey, sectionName.slice(0, 200));
    } else if (defaultSection) {
      sectionKey = `id:${defaultSection}`;
    } else {
      errors.push('No section (map a section column or choose a default section)');
    }
    let status: CsvPreviewRow['status'] = errors.length ? 'error' : 'ok';
    if (status === 'ok') {
      const target = sectionKey.startsWith('id:') ? sectionKey.slice(3) : (sectionIdByKey.get(sectionKey) ?? `new:${sectionKey}`);
      const key = dupKey(target, cardType, front, back);
      if (seen.has(key)) status = 'duplicate';
      else seen.add(key);
    }
    rows.push({
      row: i + (data.hasHeader ? 2 : 1),
      front,
      back,
      section: sectionName || (defaultSection ? (sections.find((s) => s.id === defaultSection)?.title ?? '') : ''),
      tags,
      source,
      status,
      errors,
      explanation: cell(r, m.explanation),
      hint: cell(r, m.hint),
      sectionKey,
      cardType,
      type: cardType,
    });
  });
  const preview: CsvPreview = {
    headers,
    totalRows: rows.length,
    rows: rows.slice(0, 300).map(({ explanation: _e, hint: _h, sectionKey: _k, cardType: _c, ...rest }) => rest),
    valid: rows.filter((r) => r.status === 'ok').length,
    errors: rows.filter((r) => r.status === 'error').length,
    duplicates: rows.filter((r) => r.status === 'duplicate').length,
    sectionsToCreate: [...toCreate.values()],
  };
  return { preview, rows, sectionIdByKey, courseId: data.courseId };
}

export function previewCsv(ctx: Ctx, input: unknown): CsvPreview {
  return plan(ctx, input).preview;
}

export function applyCsv(ctx: Ctx, input: unknown): { imported: number; skippedDuplicates: number; skippedErrors: number; createdSections: number } {
  const extra = parse(z.object({ confirmCreateSections: z.boolean().optional(), duplicatePolicy: z.enum(['skip', 'import']).default('skip') }).passthrough(), input);
  const p = plan(ctx, input);
  if (p.preview.sectionsToCreate.length && !extra.confirmCreateSections) {
    throw badRequest('Confirm that the missing sections should be created');
  }
  const db = ctx.db;
  const ts = nowIso(ctx);
  const t = ctx.now().getTime();
  let imported = 0;
  let createdSections = 0;
  db.transaction(() => {
    let sectionPos = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM sections WHERE course_id = ?').get(p.courseId) as { p: number }).p;
    for (const r of p.rows) {
      if (r.status === 'error') continue;
      if (r.status === 'duplicate' && extra.duplicatePolicy === 'skip') continue;
      let sectionId: string;
      if (r.sectionKey.startsWith('id:')) sectionId = r.sectionKey.slice(3);
      else {
        let existing = p.sectionIdByKey.get(r.sectionKey);
        if (!existing) {
          existing = newId(t);
          db.prepare('INSERT INTO sections (id, course_id, title, kind, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            existing, p.courseId, r.section.slice(0, 200), 'lecture', sectionPos++, ts, ts,
          );
          p.sectionIdByKey.set(r.sectionKey, existing);
          createdSections++;
        }
        sectionId = existing;
      }
      const extras = { hint: r.hint.slice(0, 10_000), source: r.source };
      if (r.cardType === 'cloze') {
        // For cloze rows the back column is extra information shown after the answer.
        const explanation = [r.back.trim(), r.explanation.trim()].filter(Boolean).join('\n\n');
        createNote(ctx, { sectionId, kind: 'cloze', fields: { text: r.front, explanation, ...extras }, tags: r.tags });
      } else {
        createNote(ctx, {
          sectionId,
          kind: 'basic',
          fields: { front: r.front, back: r.back, explanation: r.explanation, ...extras },
          options: { reverse: r.cardType === 'reverse' },
          tags: r.tags,
        });
      }
      imported++;
    }
  })();
  return {
    imported,
    skippedDuplicates: extra.duplicatePolicy === 'skip' ? p.preview.duplicates : 0,
    skippedErrors: p.preview.errors,
    createdSections,
  };
}

/** Prefix values that a spreadsheet would interpret as a formula. */
export function escapeFormula(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export function exportCsv(ctx: Ctx, opts: { courseId?: string; sectionId?: string }): { filename: string; text: string } {
  let where: string;
  let id: string;
  let title: string;
  if (opts.sectionId) {
    title = getRow<{ title: string }>(ctx, 'section', opts.sectionId).title;
    where = 'c.section_id = ?';
    id = opts.sectionId;
  } else if (opts.courseId) {
    title = getRow<{ title: string }>(ctx, 'course', opts.courseId).title;
    where = 's.course_id = ?';
    id = opts.courseId;
  } else throw badRequest('Choose a course or section to export');
  const notes = ctx.db
    .prepare(
      `SELECT n.*, s.title AS section_title FROM notes n JOIN sections s ON s.id = n.section_id
       WHERE n.deleted_at IS NULL AND s.deleted_at IS NULL AND ${where.replace('c.section_id', 'n.section_id')}
       ORDER BY s.position, n.position, n.created_at`,
    )
    .all(id) as (NoteRow & { section_title: string })[];
  const header = ['front', 'back', 'section', 'tags', 'source', 'explanation', 'hint', 'type'];
  const tagStmt = ctx.db.prepare(
    `SELECT group_concat(t.name, '; ') AS tags FROM card_tags ct JOIN tags t ON t.id = ct.tag_id
     WHERE ct.card_id = (SELECT id FROM cards WHERE note_id = ? ORDER BY retired_at IS NOT NULL, variant_order LIMIT 1)`,
  );
  const firstCard = ctx.db.prepare('SELECT front, back FROM cards WHERE note_id = ? AND retired_at IS NULL ORDER BY variant_order LIMIT 1');
  const data = notes.map((n) => {
    const f = noteFields(n) as unknown as Record<string, string>;
    const common = { section: n.section_title, tags: (tagStmt.get(n.id) as { tags: string | null }).tags ?? '', source: f.source ?? '', explanation: f.explanation ?? '', hint: f.hint ?? '' };
    let row: Record<string, string>;
    if (n.kind === 'basic') row = { ...common, front: f.front, back: f.back, type: noteOptions(n).reverse ? 'reverse' : 'basic' };
    else if (n.kind === 'cloze') row = { ...common, front: f.text, back: '', type: 'cloze' };
    else {
      // Image occlusion and template notes are exported as readable text; re-import them with a course package.
      const c = (firstCard.get(n.id) as { front: string; back: string } | undefined) ?? { front: '', back: '' };
      row = { ...common, front: c.front, back: c.back, type: n.kind };
    }
    return header.map((h) => escapeFormula(row[h] ?? ''));
  });
  const text = '﻿' + Papa.unparse({ fields: header, data }, { quotes: false, newline: '\r\n' });
  const safe = title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'cards';
  return { filename: `recall-${safe}.csv`, text };
}
