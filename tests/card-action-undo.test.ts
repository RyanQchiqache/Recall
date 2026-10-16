import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, seedHierarchy, type TestApp } from './helpers.ts';

let apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.close();
  apps = [];
});

async function app() {
  const instance = await makeApp();
  apps.push(instance);
  return instance;
}

describe('reversible card actions', () => {
  it('restores tags and suspension state, and permits each Undo only once', async () => {
    const a = await app();
    const hierarchy = await seedHierarchy(a, [2]);
    const ids = hierarchy.sections[0].cardIds;
    await a.api('PATCH', `/api/cards/${ids[0]}`, { tags: ['existing'] });

    const tagged = await a.api('POST', '/api/cards/bulk', { ids, action: 'addTags', tags: ['exam'] });
    expect(tagged.status).toBe(200);
    expect(tagged.body.undoId).toEqual(expect.any(String));
    expect((await a.api('GET', `/api/cards/${ids[0]}`)).body.card.tags).toEqual(['exam', 'existing']);
    expect((await a.api('POST', `/api/cards/actions/${tagged.body.undoId}/undo`)).status).toBe(200);
    expect((await a.api('GET', `/api/cards/${ids[0]}`)).body.card.tags).toEqual(['existing']);
    expect((await a.api('POST', `/api/cards/actions/${tagged.body.undoId}/undo`)).status).toBe(409);

    const suspended = await a.api('POST', '/api/cards/bulk', { ids, action: 'suspend' });
    expect(suspended.body.undoId).toEqual(expect.any(String));
    expect((await a.api('GET', `/api/cards/${ids[1]}`)).body.card.suspendedAt).not.toBeNull();
    expect((await a.api('POST', `/api/cards/actions/${suspended.body.undoId}/undo`)).status).toBe(200);
    expect((await a.api('GET', `/api/cards/${ids[1]}`)).body.card.suspendedAt).toBeNull();
  });

  it('reports and restores every sibling card changed through one note', async () => {
    const a = await app();
    const hierarchy = await seedHierarchy(a, [0]);
    const created = await a.api('POST', '/api/notes', {
      sectionId: hierarchy.sections[0].id,
      kind: 'basic',
      fields: { front: 'Question', back: 'Answer' },
      options: { reverse: true },
      tags: ['original'],
    });
    const ids = created.body.note.cards.map((card: { id: string }) => card.id);
    expect(ids).toHaveLength(2);

    const tagged = await a.api('POST', '/api/cards/bulk', { ids: [ids[0]], action: 'addTags', tags: ['exam'] });
    expect(tagged.body.affected).toBe(2);
    expect((await a.api('POST', `/api/cards/actions/${tagged.body.undoId}/undo`)).body.affected).toBe(2);
    for (const id of ids) expect((await a.api('GET', `/api/cards/${id}`)).body.card.tags).toEqual(['original']);
  });

  it('restores exact section order after a bulk move and a reorder', async () => {
    const a = await app();
    const hierarchy = await seedHierarchy(a, [3, 2]);
    const [first, second, third] = hierarchy.sections[0].cardIds;
    const originalTarget = hierarchy.sections[1].cardIds;

    const moved = await a.api('POST', '/api/cards/bulk', {
      ids: [first, third],
      action: 'move',
      sectionId: hierarchy.sections[1].id,
    });
    expect(moved.body.undoId).toEqual(expect.any(String));
    expect((await a.api('POST', `/api/cards/actions/${moved.body.undoId}/undo`)).status).toBe(200);
    expect((await a.api('GET', `/api/cards?sectionId=${hierarchy.sections[0].id}`)).body.cards.map((card: { id: string }) => card.id)).toEqual([first, second, third]);
    expect((await a.api('GET', `/api/cards?sectionId=${hierarchy.sections[1].id}`)).body.cards.map((card: { id: string }) => card.id)).toEqual(originalTarget);

    const reordered = await a.api('POST', '/api/cards/reorder', {
      sectionId: hierarchy.sections[0].id,
      ids: [third, first, second],
    });
    expect(reordered.body.undoId).toEqual(expect.any(String));
    expect((await a.api('POST', `/api/cards/actions/${reordered.body.undoId}/undo`)).status).toBe(200);
    expect((await a.api('GET', `/api/cards?sectionId=${hierarchy.sections[0].id}`)).body.cards.map((card: { id: string }) => card.id)).toEqual([first, second, third]);
  });

  it('refuses Undo when an affected card changed after the action', async () => {
    const a = await app();
    const hierarchy = await seedHierarchy(a, [2, 1]);
    const id = hierarchy.sections[0].cardIds[0];
    const moved = await a.api('POST', '/api/cards/bulk', {
      ids: [id],
      action: 'move',
      sectionId: hierarchy.sections[1].id,
    });
    const current = (await a.api('GET', `/api/cards/${id}`)).body.card;
    await a.api('PATCH', `/api/cards/${id}`, { revision: current.revision, front: 'Changed after moving' });

    const undo = await a.api('POST', `/api/cards/actions/${moved.body.undoId}/undo`);
    expect(undo.status).toBe(409);
    expect(undo.body.error.code).toBe('card_action_conflict');
    const after = (await a.api('GET', `/api/cards/${id}`)).body.card;
    expect(after.front).toBe('Changed after moving');
    expect(after.sectionId).toBe(hierarchy.sections[1].id);
  });

  it('refuses move Undo when a touched section was reordered later', async () => {
    const a = await app();
    const hierarchy = await seedHierarchy(a, [2, 2]);
    const id = hierarchy.sections[0].cardIds[0];
    const moved = await a.api('POST', '/api/cards/bulk', {
      ids: [id],
      action: 'move',
      sectionId: hierarchy.sections[1].id,
    });
    const targetCards = (await a.api('GET', `/api/cards?sectionId=${hierarchy.sections[1].id}`)).body.cards;
    await a.api('POST', '/api/cards/reorder', {
      sectionId: hierarchy.sections[1].id,
      ids: targetCards.map((card: { id: string }) => card.id).reverse(),
    });

    const undo = await a.api('POST', `/api/cards/actions/${moved.body.undoId}/undo`);
    expect(undo.status).toBe(409);
    expect(undo.body.error.code).toBe('card_action_conflict');
  });
});
