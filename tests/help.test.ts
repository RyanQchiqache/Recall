import { describe, expect, it } from 'vitest';
import { HELP_CATEGORIES, HELP_ITEMS, helpSearchText } from '../src/lib/helpContent.ts';

describe('offline help content', () => {
  it('has unique, addressable questions in valid categories', () => {
    const ids = HELP_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z0-9-]+$/.test(id))).toBe(true);
    const categories = new Set(HELP_CATEGORIES.map((category) => category.id));
    expect(HELP_ITEMS.every((item) => categories.has(item.category))).toBe(true);
    expect(HELP_CATEGORIES.every((category) => HELP_ITEMS.some((item) => item.category === category.id))).toBe(true);
  });

  it('answers every essential first-version topic', () => {
    for (const id of ['library-structure', 'create-card', 'drafts', 'study-modes', 'include-new', 'session-size', 'session-order', 'session-filters', 'ratings', 'next-review', 'daily-plan', 'readiness', 'statistics', 'search-cards', 'backup-types', 'restore-safety', 'keyboard-shortcuts']) {
      const item = HELP_ITEMS.find((entry) => entry.id === id);
      expect(item, `missing ${id}`).toBeDefined();
      expect(item?.question.endsWith('?')).toBe(true);
      expect(item?.answer.length).toBeGreaterThan(40);
    }
  });

  it('keeps essential help and destinations local', () => {
    for (const item of HELP_ITEMS) {
      expect(helpSearchText(item)).toContain(item.question.toLocaleLowerCase());
      if (item.link) expect(item.link.to).toMatch(/^\//);
      expect(item.answer).not.toMatch(/https?:\/\//);
    }
  });
});
