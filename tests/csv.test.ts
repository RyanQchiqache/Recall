import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, seedHierarchy, type TestApp } from './helpers.ts';

let apps: TestApp[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
});

const CSV = [
  'Question,Answer,Section,Tags,Source',
  '"What is NMS?","Removes duplicate boxes, keeping the best",Week 1,"cv; detection",Lecture 3',
  '"Multi-line","Line one',
  'Line two with ""quotes""",Week 2,,',
  'Ümlaut äöü,Grüße 日本語,Week 1,unicode,',
  ',missing front,Week 1,,',
  '"=1+1","\'=SUM(A1)",Week 1,,',
].join('\r\n');

describe('CSV import and export', () => {
  it('maps columns, previews row errors, creates sections only after confirmation, and skips duplicates', async () => {
    const a = await makeApp();
    apps.push(a);
    const h = await seedHierarchy(a, [0]);
    const inspect = (await a.api('POST', '/api/import/csv/inspect', { text: CSV })).body;
    expect(inspect.headers).toEqual(['Question', 'Answer', 'Section', 'Tags', 'Source']);
    expect(inspect.suggestedMapping).toMatchObject({ front: 0, back: 1, section: 2, tags: 3, source: 4 });
    const req = { text: CSV, courseId: h.course.id, hasHeader: true, mapping: { front: 0, back: 1, section: 2, tags: 3, source: 4 } };
    const prev = (await a.api('POST', '/api/import/csv/preview', req)).body;
    expect(prev).toMatchObject({ totalRows: 5, valid: 4, errors: 1 });
    expect(prev.sectionsToCreate).toEqual(['Week 2']); // "Week 1" exists already
    expect(prev.rows[1].back).toBe('Line one\r\nLine two with "quotes"');
    expect(prev.rows[3]).toMatchObject({ row: 5, status: 'error', errors: ['Front is empty'] });
    expect(prev.rows[2]).toMatchObject({ front: 'Ümlaut äöü', back: 'Grüße 日本語' });

    const refused = await a.api('POST', '/api/import/csv/apply', req);
    expect(refused.status).toBe(400);
    const done = (await a.api('POST', '/api/import/csv/apply', { ...req, confirmCreateSections: true })).body;
    expect(done).toMatchObject({ imported: 4, createdSections: 1, skippedErrors: 1 });
    const nms = (await a.api('GET', `/api/cards?courseId=${h.course.id}&q=NMS`)).body.cards[0];
    expect(nms).toMatchObject({ tags: ['cv', 'detection'], source: 'Lecture 3' });

    // Importing again: everything valid is a duplicate within its section.
    const again = (await a.api('POST', '/api/import/csv/preview', req)).body;
    expect(again).toMatchObject({ duplicates: 4, valid: 0 });
    const skip = (await a.api('POST', '/api/import/csv/apply', { ...req, confirmCreateSections: true, duplicatePolicy: 'skip' })).body;
    expect(skip.imported).toBe(0);
  });

  it('escapes formula-leading values on export and round-trips them on import', async () => {
    const a = await makeApp();
    apps.push(a);
    const h = await seedHierarchy(a, [0]);
    await a.api('POST', '/api/cards', { sectionId: h.sections[0].id, front: '=HYPERLINK("x")', back: '+1 and, a comma\nnew line', tags: ['t1'] });
    const exp = await a.raw('GET', `/api/export/csv?courseId=${h.course.id}`);
    const text = exp.buffer.toString('utf8');
    expect(text.startsWith('﻿')).toBe(true);
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(text).toContain(`"'+1 and, a comma\nnew line"`);

    const other = await seedHierarchy(a, [0]);
    const req = { text, courseId: other.course.id, hasHeader: true, mapping: { front: 0, back: 1, section: 2, tags: 3, source: 4 } };
    await a.api('POST', '/api/import/csv/apply', { ...req, confirmCreateSections: true });
    const imported = (await a.api('GET', `/api/cards?courseId=${other.course.id}`)).body.cards[0];
    expect(imported.front).toBe('=HYPERLINK("x")');
    expect(imported.back).toBe('+1 and, a comma\nnew line');
  });
});
