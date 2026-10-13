import { z } from 'zod';
import { nowIso, type Ctx } from '../context.ts';
import { badRequest, parseJson } from '../lib/util.ts';

/** Unsaved card-editor drafts live in SQLite so they survive reloads and restarts. */
const KEY_RE = /^(new:[\w-]{1,64}|card:[\w-]{1,64})$/;
const MAX_DRAFT_BYTES = 1_000_000;

function checkKey(key: string) {
  if (!KEY_RE.test(key)) throw badRequest('Invalid draft key');
}

export function getDraft(ctx: Ctx, key: string): { payload: unknown; updatedAt: string } | null {
  checkKey(key);
  const row = ctx.db.prepare('SELECT payload_json, updated_at FROM drafts WHERE key = ?').get(key) as
    | { payload_json: string; updated_at: string }
    | undefined;
  return row ? { payload: parseJson(row.payload_json, null), updatedAt: row.updated_at } : null;
}

export function putDraft(ctx: Ctx, key: string, payload: unknown) {
  checkKey(key);
  z.record(z.string(), z.unknown()).parse(payload);
  const json = JSON.stringify(payload);
  if (json.length > MAX_DRAFT_BYTES) throw badRequest('Draft is too large');
  const ts = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO drafts (key, payload_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
    )
    .run(key, json, ts);
  return { updatedAt: ts };
}

export function deleteDraft(ctx: Ctx, key: string) {
  checkKey(key);
  ctx.db.prepare('DELETE FROM drafts WHERE key = ?').run(key);
}
