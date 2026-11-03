import { z } from 'zod';
import type { MarkdownImportCard, MarkdownImportPreview, Section } from '../../shared/types.ts';
import type { Ctx } from '../context.ts';
import { badRequest } from '../lib/util.ts';
import { parse } from '../lib/validate.ts';
import { createItem } from './hierarchy.ts';
import { createNote } from './notes.ts';

const MAX_MARKDOWN_CHARS = 10 * 1024 * 1024;
const MAX_CARDS = 20_000;
const inputSchema = z.object({ markdown: z.string().max(MAX_MARKDOWN_CHARS, 'The Markdown file is too large (max 10 MB)') });
const createSchema = inputSchema.extend({ section: z.object({}).passthrough() });

interface ParsedMarkdown {
  suggestedTitle: string | null;
  cards: MarkdownImportCard[];
  errors: string[];
}

function questionText(line: string): string | null {
  const bold = line.match(/^\s*(?:\*\*|__)(?:Q|Question)\s*:\s*(.+?)(?:\*\*|__)\s*$/i);
  if (bold) return bold[1].trim();
  const heading = line.match(/^\s*#{2,6}\s+(?:Q|Question)\s*:\s*(.+?)\s*#*\s*$/i);
  if (heading) return heading[1].trim();
  const plain = line.match(/^\s*(?:Q|Question)\s*:\s*(.+?)\s*$/i);
  return plain ? plain[1].trim() : null;
}

export function parseMarkdownCards(raw: string): ParsedMarkdown {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) throw badRequest('The Markdown file is empty');
  if (text.length > MAX_MARKDOWN_CHARS) throw badRequest('The Markdown file is too large (max 10 MB)');
  const lines = text.split('\n');
  let suggestedTitle: string | null = null;
  let topic: string | null = null;
  let fence: string | null = null;
  let current: { question: string; answer: string[]; topic: string | null; line: number } | null = null;
  const cards: MarkdownImportCard[] = [];
  const errors: string[] = [];

  const finish = () => {
    if (!current) return;
    const answer = current.answer.join('\n').trim();
    if (!answer) errors.push(`Question on line ${current.line} has no answer`);
    else {
      cards.push({ question: current.question, answer, topic: current.topic, line: current.line });
      if (cards.length > MAX_CARDS) throw badRequest(`The Markdown file has more than ${MAX_CARDS} cards`);
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      fence = fence === marker ? null : fence ?? marker;
      if (current) current.answer.push(line);
      continue;
    }
    if (fence) {
      if (current) current.answer.push(line);
      continue;
    }
    const h1 = line.match(/^\s*#\s+(.+?)\s*#*\s*$/);
    if (h1 && !suggestedTitle) suggestedTitle = h1[1].trim().slice(0, 200);
    const question = questionText(line);
    if (question !== null) {
      finish();
      if (!question) errors.push(`Question on line ${i + 1} is empty`);
      else current = { question, answer: [], topic, line: i + 1 };
      continue;
    }
    const h2 = line.match(/^\s*##\s+(.+?)\s*#*\s*$/);
    if (h2) {
      finish();
      topic = h2[1].trim().slice(0, 60) || null;
      continue;
    }
    if (current) current.answer.push(line);
  }
  finish();
  if (!cards.length && !errors.length) {
    errors.push('No flashcards found. Write each question as **Q: Your question?** followed by its answer.');
  }
  return { suggestedTitle, cards, errors };
}

export function previewMarkdown(input: unknown): MarkdownImportPreview {
  const data = parse(inputSchema, input);
  const result = parseMarkdownCards(data.markdown);
  return { suggestedTitle: result.suggestedTitle, totalCards: result.cards.length, cards: result.cards.slice(0, 8), errors: result.errors };
}

export function createSectionFromMarkdown(ctx: Ctx, input: unknown): { section: Section; imported: number } {
  const data = parse(createSchema, input);
  const parsed = parseMarkdownCards(data.markdown);
  if (parsed.errors.length) throw badRequest('Fix the Markdown file before importing it', { problems: parsed.errors.slice(0, 20) });
  return ctx.db.transaction(() => {
    const section = createItem(ctx, 'section', data.section) as Section;
    for (const card of parsed.cards) {
      createNote(ctx, {
        sectionId: section.id,
        kind: 'basic',
        fields: { front: card.question, back: card.answer, explanation: '', hint: '', source: '' },
        tags: card.topic ? [card.topic] : [],
      });
    }
    return { section, imported: parsed.cards.length };
  })();
}
