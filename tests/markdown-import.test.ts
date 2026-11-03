import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, seedHierarchy, type TestApp } from './helpers.ts';

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function setup() {
  const app = await makeApp();
  apps.push(app);
  const hierarchy = await seedHierarchy(app, [0]);
  return { app, hierarchy };
}

const markdown = `# Lecture 03: Camera Calibration

## Camera Projection

**Q: What is the perspective projection equation?**
- $u=fX/Z$
- $v=fY/Z$

**Q: Why are homogeneous coordinates useful?**
They compose transformations and represent points at infinity.

\`\`\`text
Q: This line is code, not another card
\`\`\`

## Calibration

Question: What does SVD solve?
$A\\mathbf{v}=0$ using the right singular vector with the smallest singular value.
`;

describe('Markdown flashcard import', () => {
  it('previews questions, answers, title and topic tags', async () => {
    const { app } = await setup();
    const preview = await app.api('POST', '/api/import/markdown/preview', { markdown });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ suggestedTitle: 'Lecture 03: Camera Calibration', totalCards: 3, errors: [] });
    expect(preview.body.cards[0]).toMatchObject({ question: 'What is the perspective projection equation?', topic: 'Camera Projection' });
    expect(preview.body.cards[1].answer).toContain('Q: This line is code, not another card');
    expect(preview.body.cards[2]).toMatchObject({ question: 'What does SVD solve?', topic: 'Calibration' });
  });

  it('creates a section and all flashcards atomically', async () => {
    const { app, hierarchy } = await setup();
    const result = await app.api('POST', '/api/import/markdown/create-section', {
      markdown,
      section: { courseId: hierarchy.course.id, title: 'Week 03 — Calibration', kind: 'lecture', weekNumber: 3, notes: '' },
    });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ imported: 3, section: { title: 'Week 03 — Calibration', weekNumber: 3 } });
    const cards = (await app.api('GET', `/api/cards?sectionId=${result.body.section.id}`)).body.cards;
    expect(cards).toHaveLength(3);
    expect(cards[0].back).toContain('$u=fX/Z$');
    expect(cards[0].tags).toEqual(['Camera Projection']);
    expect(cards[2].tags).toEqual(['Calibration']);
  });

  it('reports incomplete Markdown and creates nothing', async () => {
    const { app, hierarchy } = await setup();
    const bad = '**Q: Has no answer?**';
    const preview = await app.api('POST', '/api/import/markdown/preview', { markdown: bad });
    expect(preview.body).toMatchObject({ totalCards: 0, errors: ['Question on line 1 has no answer'] });
    const before = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM sections').get();
    const result = await app.api('POST', '/api/import/markdown/create-section', {
      markdown: bad,
      section: { courseId: hierarchy.course.id, title: 'Should not exist' },
    });
    expect(result.status).toBe(400);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM sections').get()).toEqual(before);
  });

  it('rejects files without question blocks', async () => {
    const { app } = await setup();
    const result = await app.api('POST', '/api/import/markdown/preview', { markdown: '# Lecture notes\n\nOrdinary prose.' });
    expect(result.status).toBe(200);
    expect(result.body.totalCards).toBe(0);
    expect(result.body.errors[0]).toMatch(/No flashcards found/);
  });
});
