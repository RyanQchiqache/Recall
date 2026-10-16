import { describe, expect, it } from 'vitest';
import {
  clozeDisplayMarkdown,
  clozeNumbers,
  emptyFields,
  fillTemplate,
  MARK,
  nextClozeNumber,
  NoteError,
  parseCloze,
  renderNote,
  validateTemplate,
  type NoteTemplateDef,
  type OcclusionFields,
} from '../shared/notes.ts';

const extras = { explanation: '', hint: '', source: '' };

describe('cloze parsing', () => {
  it('finds numbered gaps, hints and repeated numbers', () => {
    const text = 'The {{c1::mitochondria}} is the {{c2::powerhouse::a metaphor}} of the {{c1::cell}}.';
    expect(clozeNumbers(text)).toEqual([1, 2]);
    const seg = parseCloze(text).filter((s) => s.type === 'cloze');
    expect(seg).toMatchObject([
      { ord: 1, answer: 'mitochondria', hint: null },
      { ord: 2, answer: 'powerhouse', hint: 'a metaphor' },
      { ord: 1, answer: 'cell' },
    ]);
  });

  it('handles nested braces such as LaTeX fractions, and clozes inside math', () => {
    const text = 'Gauss: $\\sum_{k=1}^{n} k = {{c1::\\frac{n(n+1)}{2}}}$ and {{c2::x}}';
    const seg = parseCloze(text).filter((s) => s.type === 'cloze');
    expect(seg[0]).toMatchObject({ ord: 1, answer: '\\frac{n(n+1)}{2}', inMath: true });
    expect(seg[1]).toMatchObject({ ord: 2, inMath: false });
    const [c1] = renderNote('cloze', { ...extras, text }, {});
    expect(c1.front).toContain('\\boxed{?}');
    expect(c1.back).toContain('\\boxed{\\frac{n(n+1)}{2}}');
  });

  it('ignores cloze syntax inside inline code and supports “::” in code answers', () => {
    expect(clozeNumbers('Use `{{c1::not a cloze}}` literally, and {{c3::`std::vector`}}')).toEqual([3]);
  });

  it('rejects nested, unclosed and empty clozes with a plain message', () => {
    expect(() => parseCloze('{{c1::outer {{c2::inner}} }}')).toThrow(NoteError);
    expect(() => parseCloze('{{c1::never closed')).toThrow(/missing its closing/);
    expect(() => parseCloze('{{c1::}}')).toThrow(/no answer/);
  });

  it('renders one card per number with the active gap blanked or highlighted', () => {
    const cards = renderNote('cloze', { ...extras, text: 'A {{c1::B}} C {{c2::D::hint}}' }, {});
    expect(cards.map((c) => c.variant)).toEqual(['c1', 'c2']);
    expect(cards[0].front).toBe('A \\[…\\] C D');
    expect(cards[0].back).toBe('A **B** C D');
    expect(cards[1].front).toBe('A B C \\[hint\\]');
    expect(cards[1].render).toEqual({ type: 'cloze', text: 'A {{c1::B}} C {{c2::D::hint}}', ord: 2 });
    const display = clozeDisplayMarkdown(parseCloze('A {{c1::B}}'), 1, 'back');
    expect(display).toBe(`A ${MARK.answerOpen}B${MARK.answerClose}`);
  });

  it('suggests the next free number', () => {
    expect(nextClozeNumber('no gaps')).toBe(1);
    expect(nextClozeNumber('{{c1::a}} {{c4::b}}')).toBe(5);
  });

  it('needs at least one gap', () => {
    expect(() => renderNote('cloze', { ...extras, text: 'plain text' }, {})).toThrow(/at least one cloze/);
  });
});

describe('basic and reverse', () => {
  it('adds a reverse card only when asked', () => {
    const f = { ...extras, front: 'Q', back: 'A' };
    expect(renderNote('basic', f, {}).map((c) => c.variant)).toEqual(['main']);
    const both = renderNote('basic', f, { reverse: true });
    expect(both.map((c) => [c.variant, c.front, c.back])).toEqual([
      ['main', 'Q', 'A'],
      ['reverse', 'A', 'Q'],
    ]);
  });

  it('requires both sides', () => {
    expect(() => renderNote('basic', { ...extras, front: ' ', back: 'A' }, {})).toThrow(/front/);
  });
});

describe('templates', () => {
  const tpl: NoteTemplateDef = {
    id: 't1',
    name: 'Vocabulary',
    revision: 1,
    fields: [
      { id: 'f1', name: 'Term' },
      { id: 'f2', name: 'Definition' },
      { id: 'f3', name: 'Example' },
    ],
    cards: [
      { id: 'k1', name: 'Term → definition', front: '{{Term}}', back: '{{FrontSide}}\n\n{{Definition}}{{#Example}}\n\n*Example:* {{Example}}{{/Example}}' },
      { id: 'k2', name: 'Example → term', front: '{{Example}}', back: '{{Term}}' },
    ],
  };

  it('fills placeholders, sections and FrontSide', () => {
    expect(fillTemplate('{{#A}}yes {{A}}{{/A}}{{^A}}none{{/A}}', (n) => (n === 'A' ? 'x' : ''))).toBe('yes x');
    expect(fillTemplate('{{#A}}yes{{/A}}{{^A}}none{{/A}}', () => '')).toBe('none');
    const cards = renderNote('template', { ...extras, values: { f1: 'entropy', f2: 'disorder', f3: 'ice melting' } }, {}, tpl);
    expect(cards.map((c) => c.variant)).toEqual(['t:k1', 't:k2']);
    expect(cards[0].back).toBe('entropy\n\ndisorder\n\n*Example:* ice melting');
  });

  it('skips card types whose front fields are empty', () => {
    const cards = renderNote('template', { ...extras, values: { f1: 'entropy', f2: 'disorder' } }, {}, tpl);
    expect(cards.map((c) => c.variant)).toEqual(['t:k1']);
    expect(cards[0].back).not.toContain('Example');
  });

  it('keeps values by field id when a field is renamed', () => {
    const renamed = { ...tpl, fields: tpl.fields.map((f) => (f.id === 'f1' ? { ...f, name: 'Word' } : f)), cards: tpl.cards.map((c) => ({ ...c, front: c.front.replace('{{Term}}', '{{Word}}'), back: c.back.replace('{{Term}}', '{{Word}}') })) };
    const cards = renderNote('template', { ...extras, values: { f1: 'entropy', f2: 'disorder' } }, {}, renamed);
    expect(cards[0].front).toBe('entropy');
  });

  it('validates names, unknown placeholders and unbalanced sections', () => {
    expect(validateTemplate(tpl)).toEqual([]);
    const bad = validateTemplate({
      name: '',
      fields: [
        { id: 'a', name: 'X' },
        { id: 'b', name: 'x' },
      ],
      cards: [{ id: 'c', name: 'C', front: '{{Missing}} {{#X}}open', back: '{{FrontSide}}' }],
    });
    const msgs = bad.map((i) => i.message).join(' | ');
    expect(msgs).toMatch(/name/);
    expect(msgs).toMatch(/Two fields are called/);
    expect(msgs).toMatch(/doesn’t exist/);
    expect(msgs).toMatch(/never closed/);
  });
});

describe('image occlusion', () => {
  const base = (): OcclusionFields => ({
    ...(emptyFields('occlusion') as OcclusionFields),
    image: '/media/01a13549-2d20-73d6-a644-ca430d9b65ff.png',
    masks: [
      { id: 'mask01', x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: 'Femur' },
      { id: 'mask02', x: 0.5, y: 0.5, w: 0.2, h: 0.1, label: '' },
    ],
  });

  it('creates one card per box, keyed by the box id', () => {
    const cards = renderNote('occlusion', base(), { occlusionMode: 'hide-one' });
    expect(cards.map((c) => c.variant)).toEqual(['m:mask01', 'm:mask02']);
    expect(cards[0].label).toBe('Box: Femur');
    expect(cards[0].front).toContain('![Image occlusion](/media/');
    expect(cards[1].render).toMatchObject({ type: 'occlusion', activeId: 'mask02', mode: 'hide-one' });
  });

  it('rejects remote images, boxes outside the image and duplicate ids', () => {
    expect(() => renderNote('occlusion', { ...base(), image: 'https://example.com/x.png' }, {})).toThrow(/image/);
    expect(() => renderNote('occlusion', { ...base(), masks: [{ id: 'mask01', x: 0.9, y: 0.1, w: 0.3, h: 0.2, label: '' }] }, {})).toThrow(/outside/);
    const dup = base();
    dup.masks[1].id = 'mask01';
    expect(() => renderNote('occlusion', dup, {})).toThrow(/duplicate/);
  });
});
