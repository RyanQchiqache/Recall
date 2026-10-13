import fs from 'node:fs';
import path from 'node:path';
import type { MediaAsset } from '../../shared/types.ts';
import { nowIso, type Ctx } from '../context.ts';
import { AppError, newId, sha256 } from '../lib/util.ts';

export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

export const MEDIA_FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Detect a supported raster image type from its actual bytes (not the name or declared type). */
export function detectImageType(buf: Uint8Array): { ext: string; mime: string } | null {
  const b = buf;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { ext: 'png', mime: MIME_BY_EXT.png };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: MIME_BY_EXT.jpg };
  if (b.length >= 6) {
    const sig = String.fromCharCode(...b.slice(0, 6));
    if (sig === 'GIF87a' || sig === 'GIF89a') return { ext: 'gif', mime: MIME_BY_EXT.gif };
  }
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') {
    return { ext: 'webp', mime: MIME_BY_EXT.webp };
  }
  return null;
}

export function mimeForFilename(filename: string): string | null {
  const ext = filename.split('.').pop() ?? '';
  return MIME_BY_EXT[ext] ?? null;
}

interface MediaRow {
  id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
}

const toAsset = (r: MediaRow): MediaAsset => ({
  id: r.id,
  filename: r.filename,
  url: `/media/${r.filename}`,
  mimeType: r.mime_type,
  sizeBytes: r.size_bytes,
  originalName: r.original_name,
});

export function saveMedia(ctx: Ctx, buf: Buffer, originalName: string, opts: { isDemo?: boolean } = {}): MediaAsset {
  if (buf.length === 0) throw new AppError(400, 'empty_file', 'The file is empty');
  if (buf.length > MAX_MEDIA_BYTES) throw new AppError(413, 'file_too_large', 'Images must be 15 MB or smaller');
  const type = detectImageType(buf);
  if (!type) throw new AppError(415, 'unsupported_type', 'Only PNG, JPEG, GIF and WebP images are supported');
  const hash = sha256(buf);
  const existing = ctx.db.prepare('SELECT * FROM media_assets WHERE sha256 = ? AND size_bytes = ?').get(hash, buf.length) as
    | MediaRow
    | undefined;
  if (existing && fs.existsSync(path.join(ctx.config.mediaDir, existing.filename))) return toAsset(existing);
  const id = newId(ctx.now().getTime());
  const filename = `${id}.${type.ext}`;
  fs.mkdirSync(ctx.config.mediaDir, { recursive: true });
  const target = path.join(ctx.config.mediaDir, filename);
  const tmp = `${target}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, target);
  const cleanName = path.basename(originalName || 'image').replace(/[^\w.\- ]+/g, '').slice(0, 120);
  ctx.db
    .prepare(
      'INSERT INTO media_assets (id, filename, original_name, mime_type, size_bytes, sha256, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, filename, cleanName, type.mime, buf.length, hash, opts.isDemo ? 1 : 0, nowIso(ctx));
  return toAsset(ctx.db.prepare('SELECT * FROM media_assets WHERE id = ?').get(id) as MediaRow);
}

/** Resolve a media filename to an absolute path inside the media dir, or null if invalid. */
export function mediaPath(ctx: Ctx, filename: string): string | null {
  if (!MEDIA_FILENAME_RE.test(filename)) return null;
  const p = path.join(ctx.config.mediaDir, filename);
  if (path.dirname(p) !== path.resolve(ctx.config.mediaDir)) return null;
  return p;
}

/** Media filenames referenced by Markdown text. */
export function referencedMedia(text: string): string[] {
  const out = new Set<string>();
  const re = /\/media\/([0-9a-f-]{36}\.(?:png|jpg|gif|webp))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1]);
  return [...out];
}
