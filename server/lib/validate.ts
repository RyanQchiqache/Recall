import { z } from 'zod';
import { isLocalDate } from '../../shared/dates.ts';
import { badRequest } from './util.ts';

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = issues[0];
    throw badRequest(first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : 'Invalid input', issues);
  }
  return r.data;
}

export const zTitle = z.string().trim().min(1, 'Title is required').max(200, 'Title is too long');
export const zText = (max: number) => z.string().max(max, `Must be at most ${max} characters`);
export const zId = z.string().min(1).max(64);
export const zLocalDate = z
  .string()
  .refine((v) => isLocalDate(v), 'Must be a valid date (YYYY-MM-DD)');
export const zOptDate = z
  .union([zLocalDate, z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : v === undefined ? undefined : null));
