import crypto from 'node:crypto';

/** Time-ordered UUIDv7: stable, unique, and sortable by creation. */
export function newId(now: number = Date.now()): string {
  const bytes = crypto.randomBytes(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

export function bool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Normalize text for duplicate detection: trim, collapse whitespace, case-fold. */
export function normalizeForCompare(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function sha256(buf: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Placeholders for `IN (...)` with parameter binding. */
export function placeholders(n: number): string {
  return n === 0 ? 'NULL' : new Array(n).fill('?').join(',');
}
