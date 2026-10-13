import { localDateOf } from '../../shared/dates.ts';
import type { Ctx } from '../context.ts';
import { getSettings } from './settings.ts';

export function timeZoneOf(ctx: Ctx): string {
  return getSettings(ctx).timeZone;
}

/** Today's calendar date in the configured timezone. */
export function today(ctx: Ctx): string {
  return localDateOf(ctx.now(), timeZoneOf(ctx));
}
