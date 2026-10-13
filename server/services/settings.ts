import path from 'node:path';
import { isValidTimeZone } from '../../shared/dates.ts';
import { normalizeSettings, type AppSettings } from '../../shared/settings.ts';
import { nowIso, type Ctx } from '../context.ts';
import { badRequest, parseJson } from '../lib/util.ts';

const KEY = 'app';

export function getSettings(ctx: Ctx): AppSettings {
  const row = ctx.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(KEY) as
    | { value_json: string }
    | undefined;
  return normalizeSettings(parseJson(row?.value_json, {}));
}

export function saveSettings(ctx: Ctx, settings: AppSettings): AppSettings {
  const normalized = normalizeSettings(settings);
  ctx.db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .run(KEY, JSON.stringify(normalized), nowIso(ctx));
  return normalized;
}

/** Apply a partial update. Scheduling changes only affect future reviews. */
export function updateSettings(ctx: Ctx, patch: Record<string, unknown>): AppSettings {
  const current = getSettings(ctx);
  if (patch.timeZone !== undefined && (typeof patch.timeZone !== 'string' || !isValidTimeZone(patch.timeZone))) {
    throw badRequest(`"${String(patch.timeZone)}" is not a valid IANA timezone`);
  }
  const backupPatch = (patch.backup ?? {}) as Record<string, unknown>;
  if (typeof backupPatch.directory === 'string' && backupPatch.directory.trim()) {
    if (!path.isAbsolute(backupPatch.directory.trim())) throw badRequest('Backup directory must be an absolute path');
  }
  const schedulerPatch = (patch.scheduler ?? {}) as Record<string, unknown>;
  const merged = {
    ...current,
    ...patch,
    scheduler: { ...current.scheduler, ...schedulerPatch },
    backup: { ...current.backup, ...backupPatch },
  };
  return saveSettings(ctx, merged as AppSettings);
}

export function getMeta<T>(ctx: Ctx, key: string, fallback: T): T {
  const row = ctx.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(`meta:${key}`) as
    | { value_json: string }
    | undefined;
  return parseJson(row?.value_json, fallback);
}

export function setMeta(ctx: Ctx, key: string, value: unknown): void {
  ctx.db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .run(`meta:${key}`, JSON.stringify(value), nowIso(ctx));
}
