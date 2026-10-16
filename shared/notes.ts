/**
 * Notes and the cards they generate.
 *
 * A note is what the user writes. It produces one or more cards, and each card is
 * scheduled on its own. Every generated card has a permanent variant key, so editing a
 * note maps old cards to new ones without losing history:
 *
 *   basic      main, reverse         (reverse only when the option is on)
 *   cloze      c1, c2, …             (one card per cloze number)
 *   occlusion  m:<maskId>            (one card per mask)
 *   template   t:<cardTypeId>        (one card per card type whose front has content)
 *
 * Everything here is pure, so the server and the editor preview use the same rules.
 */

export const NOTE_KINDS = ['basic', 'cloze', 'occlusion', 'template'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTE_KIND_LABEL: Record<NoteKind, string> = {
  basic: 'Basic',
  cloze: 'Cloze',
  occlusion: 'Image occlusion',
  template: 'Template',
};

export interface NoteExtras {
  explanation: string;
  hint: string;
  source: string;
}
export interface BasicFields extends NoteExtras {
  front: string;
  back: string;
}
export interface ClozeFields extends NoteExtras {
  text: string;
}
export interface OcclusionMask {
  id: string;
  /** Position and size as fractions (0–1) of the image width/height. */
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}
export interface OcclusionFields extends NoteExtras {
  image: string;
  header: string;
  masks: OcclusionMask[];
}
export interface TemplateFields extends NoteExtras {
  /** Values keyed by the template field's permanent id (renaming a field keeps its values). */
  values: Record<string, string>;
}
export type NoteFields = BasicFields | ClozeFields | OcclusionFields | TemplateFields;

export type OcclusionMode = 'hide-all' | 'hide-one';
export interface NoteOptions {
  reverse?: boolean;
  occlusionMode?: OcclusionMode;
}

export interface TemplateField {
  id: string;
  name: string;
  removed?: boolean;
}
export interface TemplateCardType {
  id: string;
  name: string;
  front: string;
  back: string;
  removed?: boolean;
}
export interface NoteTemplateDef {
  id: string;
  name: string;
  fields: TemplateField[];
  cards: TemplateCardType[];
  revision: number;
}

export type CardRender =
  | { type: 'markdown' }
  | { type: 'cloze'; text: string; ord: number }
  | { type: 'occlusion'; image: string; header: string; masks: OcclusionMask[]; activeId: string; mode: OcclusionMode };

export interface RenderedCard {
  variant: string;
  order: number;
  /** Short name of the variant shown in lists and while studying ('' for a plain basic card). */
  label: string;
  /** Readable Markdown used for search, lists, CSV and the session snapshot. */
  front: string;
  back: string;
  render: CardRender;
}

export class NoteError extends Error {}

export const MAX_FIELD_LENGTH = 200_000;
export const MAX_CLOZE_NUMBER = 99;
export const MAX_MASKS = 100;
export const LOCAL_MEDIA_RE = /^\/media\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;
const MASK_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;

// ---------------------------------------------------------------------------
// Cloze parsing
// ---------------------------------------------------------------------------

export type ClozeSegment =
  | { type: 'text'; value: string }
  | { type: 'cloze'; ord: number; answer: string; hint: string | null; inMath: boolean };

/**
 * Parse `{{c1::answer}}` and `{{c1::answer::hint}}`.
 *
 * The scanner is aware of braces (so `{{c1::\frac{a}{b}}}` works), inline code (no
 * clozes inside backticks) and math (a cloze inside `$…$` is marked so it can be shown
 * with LaTeX instead of text). Throws NoteError with a plain-language message.
 */
export function parseCloze(text: string): ClozeSegment[] {
  const out: ClozeSegment[] = [];
  let buf = '';
  let i = 0;
  let inCode = false;
  let math: '' | '$' | '$$' = '';
  const flush = () => {
    if (buf) out.push({ type: 'text', value: buf });
    buf = '';
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      buf += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '`') {
      inCode = !inCode;
      buf += ch;
      i++;
      continue;
    }
    if (!inCode && ch === '$') {
      if (text.startsWith('$$', i)) {
        math = math === '$$' ? '' : math === '' ? '$$' : math;
        buf += '$$';
        i += 2;
      } else {
        math = math === '$' ? '' : math === '' ? '$' : math;
        buf += '$';
        i++;
      }
      continue;
    }
    const open = !inCode && /^\{\{c(\d{1,3})::/.exec(text.slice(i, i + 8));
    if (open) {
      const ord = Number(open[1]);
      if (ord < 1 || ord > MAX_CLOZE_NUMBER) throw new NoteError(`Cloze numbers must be between 1 and ${MAX_CLOZE_NUMBER} (found c${open[1]}).`);
      let j = i + open[0].length;
      let depth = 0;
      let innerCode = false;
      let sep = -1;
      let end = -1;
      while (j < text.length) {
        const c = text[j];
        if (c === '\\' && j + 1 < text.length) {
          j += 2;
          continue;
        }
        if (c === '`') innerCode = !innerCode;
        else if (!innerCode) {
          if (text.startsWith('{{c', j) && /^\{\{c\d{1,3}::/.test(text.slice(j, j + 8))) {
            throw new NoteError('Clozes cannot be nested inside each other.');
          }
          if (c === '{') depth++;
          else if (c === '}') {
            if (depth === 0 && text[j + 1] === '}') {
              end = j;
              break;
            }
            depth = Math.max(0, depth - 1);
          } else if (c === ':' && text[j + 1] === ':' && depth === 0 && sep < 0) {
            sep = j;
            j += 2;
            continue;
          }
        }
        j++;
      }
      if (end < 0) throw new NoteError(`A cloze starting with “{{c${ord}::” is missing its closing “}}”.`);
      const body = text.slice(i + open[0].length, end);
      const answer = sep >= 0 ? text.slice(i + open[0].length, sep) : body;
      const hint = sep >= 0 ? text.slice(sep + 2, end).trim() : null;
      if (!answer.trim()) throw new NoteError(`Cloze c${ord} has no answer text.`);
      if (math && /\$/.test(answer)) throw new NoteError('A cloze inside an equation cannot contain another “$”.');
      flush();
      out.push({ type: 'cloze', ord, answer, hint: hint || null, inMath: math !== '' });
      i = end + 2;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

export function clozeNumbers(text: string): number[] {
  return [...new Set(parseCloze(text).flatMap((s) => (s.type === 'cloze' ? [s.ord] : [])))].sort((a, b) => a - b);
}

/** Smallest cloze number not used yet (for the “Make cloze” button). */
export function nextClozeNumber(text: string): number {
  let used: number[] = [];
  try {
    used = clozeNumbers(text);
  } catch {
    used = [...text.matchAll(/\{\{c(\d{1,3})::/g)].map((m) => Number(m[1]));
  }
  return used.length ? Math.min(MAX_CLOZE_NUMBER, Math.max(...used) + 1) : 1;
}

const escapeMd = (s: string) => s.replace(/([[\]])/g, '\\$1');

/**
 * Plain Markdown for one cloze card: the active gap becomes “[…]” (or “[hint]”) on the
 * front and **bold** on the back; other gaps show their answers.
 */
export function clozeMarkdown(segments: ClozeSegment[], ord: number, side: 'front' | 'back'): string {
  return segments
    .map((s) => {
      if (s.type === 'text') return s.value;
      if (s.ord !== ord) return s.answer;
      if (s.inMath) return side === 'front' ? `\\boxed{${s.hint ? `\\text{${s.hint.replace(/[{}\\$]/g, '')}}` : '?'}}` : `\\boxed{${s.answer}}`;
      return side === 'front' ? `\\[${escapeMd(s.hint ?? '…')}\\]` : `**${s.answer}**`;
    })
    .join('');
}

/** Private-use markers the study renderer turns into highlighted spans. */
export const MARK = { blankOpen: '', blankClose: '', answerOpen: '', answerClose: '' } as const;

/** Markdown with private-use markers around the active gap, for the rich cloze view. */
export function clozeDisplayMarkdown(segments: ClozeSegment[], ord: number, side: 'front' | 'back'): string {
  return segments
    .map((s) => {
      if (s.type === 'text') return s.value;
      if (s.ord !== ord) return s.answer;
      if (s.inMath) return clozeMarkdown([s], ord, side);
      return side === 'front' ? `${MARK.blankOpen}${s.hint ?? '…'}${MARK.blankClose}` : `${MARK.answerOpen}${s.answer}${MARK.answerClose}`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{\{\s*([#^/]?)\s*([^{}#^/][^{}]*?)\s*\}\}/g;
const RESERVED_FIELD = 'FrontSide';

export interface TemplateIssue {
  where: string;
  message: string;
}

/** Field names a template text refers to (plain placeholders and section tags). */
export function placeholdersIn(text: string): { name: string; kind: '' | '#' | '^' | '/' }[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => ({ name: m[2].trim(), kind: m[1] as '' | '#' | '^' | '/' }));
}

export function validateTemplate(def: Pick<NoteTemplateDef, 'name' | 'fields' | 'cards'>): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  if (!def.name.trim()) issues.push({ where: 'name', message: 'Give the template a name.' });
  const active = def.fields.filter((f) => !f.removed);
  if (active.length === 0) issues.push({ where: 'fields', message: 'A template needs at least one field.' });
  const seen = new Set<string>();
  for (const f of def.fields) {
    const n = f.name.trim();
    if (!n) issues.push({ where: `field:${f.id}`, message: 'Every field needs a name.' });
    else if (/[{}#^/]/.test(n)) issues.push({ where: `field:${f.id}`, message: `Field names cannot contain { } # ^ or / (“${n}”).` });
    else if (n === RESERVED_FIELD) issues.push({ where: `field:${f.id}`, message: '“FrontSide” is reserved for showing the front on the back.' });
    else if (seen.has(n.toLowerCase())) issues.push({ where: `field:${f.id}`, message: `Two fields are called “${n}”.` });
    seen.add(n.toLowerCase());
  }
  const activeCards = def.cards.filter((c) => !c.removed);
  if (activeCards.length === 0) issues.push({ where: 'cards', message: 'A template needs at least one card type.' });
  const names = new Set(active.map((f) => f.name.trim()));
  for (const c of def.cards) {
    if (c.removed) continue;
    if (!c.name.trim()) issues.push({ where: `card:${c.id}`, message: 'Every card type needs a name.' });
    for (const side of ['front', 'back'] as const) {
      const text = c[side];
      const stack: string[] = [];
      for (const p of placeholdersIn(text)) {
        if (p.name === RESERVED_FIELD && p.kind === '') {
          if (side === 'front') issues.push({ where: `card:${c.id}:front`, message: '{{FrontSide}} can only be used on the back.' });
          continue;
        }
        if (!names.has(p.name)) issues.push({ where: `card:${c.id}:${side}`, message: `“{{${p.kind}${p.name}}}” refers to a field that doesn’t exist.` });
        if (p.kind === '#' || p.kind === '^') stack.push(p.name);
        if (p.kind === '/') {
          const top = stack.pop();
          if (top !== p.name) issues.push({ where: `card:${c.id}:${side}`, message: `“{{/${p.name}}}” doesn’t close the section that is open.` });
        }
      }
      if (stack.length) issues.push({ where: `card:${c.id}:${side}`, message: `The section “{{#${stack[stack.length - 1]}}}” is never closed with “{{/${stack[stack.length - 1]}}}”.` });
    }
    if (!c.front.trim()) issues.push({ where: `card:${c.id}:front`, message: `The front of “${c.name || 'this card type'}” is empty.` });
  }
  return issues;
}

/** Fill a template text with values. Supports {{Field}}, {{#Field}}…{{/Field}}, {{^Field}}…{{/Field}} and {{FrontSide}}. */
export function fillTemplate(text: string, valueOf: (name: string) => string, frontSide = ''): string {
  // Sections first (innermost-first by repeated replacement), then plain placeholders.
  let out = text;
  const section = /\{\{\s*([#^])\s*([^{}#^/][^{}]*?)\s*\}\}([\s\S]*?)\{\{\s*\/\s*\2\s*\}\}/;
  for (let guard = 0; guard < 200; guard++) {
    const m = section.exec(out);
    if (!m) break;
    const has = valueOf(m[2].trim()).trim().length > 0;
    const keep = m[1] === '#' ? has : !has;
    out = out.slice(0, m.index) + (keep ? m[3] : '') + out.slice(m.index + m[0].length);
  }
  return out.replace(/\{\{\s*([^{}#^/][^{}]*?)\s*\}\}/g, (_all, name: string) => (name.trim() === RESERVED_FIELD ? frontSide : valueOf(name.trim())));
}

function fieldsReferenced(text: string): Set<string> {
  return new Set(placeholdersIn(text).filter((p) => p.kind === '' || p.kind === '#').map((p) => p.name));
}

// ---------------------------------------------------------------------------
// Rendering a note into cards
// ---------------------------------------------------------------------------

export function emptyFields(kind: NoteKind): NoteFields {
  const extras: NoteExtras = { explanation: '', hint: '', source: '' };
  switch (kind) {
    case 'basic':
      return { ...extras, front: '', back: '' };
    case 'cloze':
      return { ...extras, text: '' };
    case 'occlusion':
      return { ...extras, image: '', header: '', masks: [] };
    case 'template':
      return { ...extras, values: {} };
  }
}

/** Shared validation of a note before rendering (shape is checked separately). */
export function noteProblems(kind: NoteKind, fields: NoteFields, template?: NoteTemplateDef | null): string[] {
  const problems: string[] = [];
  const tooLong = Object.values(fields).some((v) => typeof v === 'string' && v.length > MAX_FIELD_LENGTH);
  if (tooLong) problems.push('A field is longer than 200,000 characters.');
  switch (kind) {
    case 'basic': {
      const f = fields as BasicFields;
      if (!f.front.trim()) problems.push('The front (question) is required. An image on its own is fine.');
      if (!f.back.trim()) problems.push('The back (answer) is required.');
      break;
    }
    case 'cloze': {
      const f = fields as ClozeFields;
      try {
        if (clozeNumbers(f.text).length === 0) problems.push('Add at least one cloze, for example {{c1::answer}}. Select text and press “Make cloze”.');
      } catch (e) {
        problems.push((e as Error).message);
      }
      break;
    }
    case 'occlusion': {
      const f = fields as OcclusionFields;
      if (!LOCAL_MEDIA_RE.test(f.image)) problems.push('Choose an image for the occlusion card.');
      if (f.masks.length === 0) problems.push('Draw at least one box over the part to hide.');
      if (f.masks.length > MAX_MASKS) problems.push(`Use at most ${MAX_MASKS} boxes per image.`);
      const ids = new Set<string>();
      for (const m of f.masks) {
        if (!MASK_ID_RE.test(m.id) || ids.has(m.id)) problems.push('A box has an invalid or duplicate id.');
        ids.add(m.id);
        const ok = [m.x, m.y, m.w, m.h].every((v) => Number.isFinite(v)) && m.x >= 0 && m.y >= 0 && m.w >= 0.005 && m.h >= 0.005 && m.x + m.w <= 1.0001 && m.y + m.h <= 1.0001;
        if (!ok) problems.push('A box lies outside the image or is too small.');
        if (m.label.length > 200) problems.push('Box labels must be at most 200 characters.');
      }
      break;
    }
    case 'template': {
      if (!template) {
        problems.push('The template for this note no longer exists.');
        break;
      }
      const f = fields as TemplateFields;
      const anyValue = template.fields.some((tf) => !tf.removed && (f.values[tf.id] ?? '').trim());
      if (!anyValue) problems.push('Fill in at least one field.');
      else if (renderTemplate(template, f).length === 0) problems.push('With these fields, no card type has anything on its front. Fill in the fields the fronts use.');
      break;
    }
  }
  return [...new Set(problems)];
}

function renderTemplate(template: NoteTemplateDef, fields: TemplateFields): RenderedCard[] {
  const byName = new Map(template.fields.filter((f) => !f.removed).map((f) => [f.name.trim(), f.id]));
  const valueOf = (name: string) => {
    const id = byName.get(name);
    return id ? (fields.values[id] ?? '') : '';
  };
  const out: RenderedCard[] = [];
  template.cards.forEach((ct, index) => {
    if (ct.removed) return;
    const refs = fieldsReferenced(ct.front);
    const generates = refs.size === 0 || [...refs].some((n) => valueOf(n).trim().length > 0);
    if (!generates) return;
    const front = fillTemplate(ct.front, valueOf).trim();
    if (!front) return;
    const back = fillTemplate(ct.back, valueOf, front).trim();
    out.push({ variant: `t:${ct.id}`, order: index, label: ct.name.trim(), front, back: back || ' ', render: { type: 'markdown' } });
  });
  return out;
}

/** All cards a note currently generates, in display order. Throws NoteError when invalid. */
export function renderNote(kind: NoteKind, fields: NoteFields, options: NoteOptions, template?: NoteTemplateDef | null): RenderedCard[] {
  const problems = noteProblems(kind, fields, template);
  if (problems.length) throw new NoteError(problems[0]);
  switch (kind) {
    case 'basic': {
      const f = fields as BasicFields;
      const cards: RenderedCard[] = [{ variant: 'main', order: 0, label: '', front: f.front, back: f.back, render: { type: 'markdown' } }];
      if (options.reverse) cards.push({ variant: 'reverse', order: 1, label: 'Reverse', front: f.back, back: f.front, render: { type: 'markdown' } });
      return cards;
    }
    case 'cloze': {
      const f = fields as ClozeFields;
      const segments = parseCloze(f.text);
      return clozeNumbers(f.text).map((ord) => ({
        variant: `c${ord}`,
        order: ord,
        label: `Cloze ${ord}`,
        front: clozeMarkdown(segments, ord, 'front'),
        back: clozeMarkdown(segments, ord, 'back'),
        render: { type: 'cloze', text: f.text, ord },
      }));
    }
    case 'occlusion': {
      const f = fields as OcclusionFields;
      const mode = options.occlusionMode === 'hide-one' ? 'hide-one' : 'hide-all';
      const header = f.header.trim();
      return f.masks.map((m, i) => {
        const name = m.label.trim() || `Box ${i + 1}`;
        return {
          variant: `m:${m.id}`,
          order: i,
          label: m.label.trim() ? `Box: ${m.label.trim()}` : `Box ${i + 1}`,
          front: `![Image occlusion](${f.image})${header ? `\n\n${header}` : ''}\n\nWhat is hidden under box ${i + 1}?`,
          back: `**${name}**${header ? `\n\n${header}` : ''}`,
          render: { type: 'occlusion', image: f.image, header, masks: f.masks, activeId: m.id, mode },
        };
      });
    }
    case 'template':
      return renderTemplate(template!, fields as TemplateFields);
  }
}

/** A short, readable title for a note (lists, trash, toasts). */
export function noteTitle(kind: NoteKind, fields: NoteFields, template?: NoteTemplateDef | null): string {
  switch (kind) {
    case 'basic':
      return (fields as BasicFields).front;
    case 'cloze': {
      try {
        return clozeMarkdown(parseCloze((fields as ClozeFields).text), -1, 'front');
      } catch {
        return (fields as ClozeFields).text;
      }
    }
    case 'occlusion':
      return (fields as OcclusionFields).header || `Image occlusion (${(fields as OcclusionFields).masks.length} boxes)`;
    case 'template': {
      const f = fields as TemplateFields;
      const first = template?.fields.find((tf) => !tf.removed && (f.values[tf.id] ?? '').trim());
      return first ? f.values[first.id] : 'Template note';
    }
  }
}

export function newMaskId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
}
