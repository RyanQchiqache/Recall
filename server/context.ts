import type { AppConfig } from './config.ts';
import type { DB } from './db/connection.ts';

export interface Ctx {
  db: DB;
  config: AppConfig;
  /** Injected clock — tests pass a controllable one. */
  now: () => Date;
  /** Injected randomness for session seeds. */
  random: () => number;
}

export const nowIso = (ctx: Ctx) => ctx.now().toISOString();
