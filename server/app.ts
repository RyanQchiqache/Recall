import fs from 'node:fs';
import path from 'node:path';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config.ts';
import type { Ctx } from './context.ts';
import { openDatabase, type DB } from './db/connection.ts';
import { AppError } from './lib/util.ts';
import { registerRoutes } from './routes.ts';
import { cleanupTmp } from './services/backup.ts';
import { mediaPath, mimeForFilename } from './services/media.ts';

export interface BuildOptions {
  config: AppConfig;
  now?: () => Date;
  random?: () => number;
  logger?: boolean;
  db?: DB;
  log?: (msg: string) => void;
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: Ctx;
  close: () => Promise<void>;
}

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export function allowedHosts(config: AppConfig): Set<string> {
  const ports = [config.port, ...(config.dev ? [5173] : [])];
  const hosts = new Set<string>();
  for (const p of ports) for (const h of ['127.0.0.1', 'localhost', '[::1]']) hosts.add(`${h}:${p}`);
  return hosts;
}

export function allowedOrigins(config: AppConfig): Set<string> {
  const origins = new Set<string>(config.extraOrigins);
  for (const h of ['127.0.0.1', 'localhost', '[::1]']) origins.add(`http://${h}:${config.port}`);
  return origins;
}

export async function buildApp(opts: BuildOptions): Promise<BuiltApp> {
  const { config } = opts;
  for (const dir of [config.dataDir, config.mediaDir, config.tmpDir]) fs.mkdirSync(dir, { recursive: true });
  const db =
    opts.db ??
    (await openDatabase(config.dbPath, {
      snapshotDir: config.defaultBackupDir,
      now: opts.now,
      log: opts.log ?? ((m) => console.log(m)),
    }));
  const ctx: Ctx = { db, config, now: opts.now ?? (() => new Date()), random: opts.random ?? Math.random };
  cleanupTmp(ctx);

  const app = Fastify({
    logger: opts.logger ? { level: 'warn' } : false,
    bodyLimit: 25 * 1024 * 1024,
    trustProxy: false,
  });

  const hosts = allowedHosts(config);
  const origins = allowedOrigins(config);

  // DNS-rebinding and cross-site request protection for a loopback-only app.
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) {
      reply.code(421).send({ error: { code: 'bad_host', message: 'Recall only answers requests addressed to its own loopback address' } });
      return reply;
    }
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      if (origin !== undefined && !origins.has(origin)) {
        reply.code(403).send({ error: { code: 'bad_origin', message: 'Cross-origin requests are not allowed' } });
        return reply;
      }
      if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
        reply.code(403).send({ error: { code: 'bad_origin', message: 'Cross-site requests are not allowed' } });
        return reply;
      }
      // A custom header forces a CORS preflight for any cross-origin script, which we never approve.
      if (req.url.startsWith('/api/') && req.headers['x-recall-client'] !== '1') {
        reply.code(403).send({ error: { code: 'missing_client_header', message: 'Missing X-Recall-Client header' } });
        return reply;
      }
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (!config.dev) reply.header('Content-Security-Policy', PROD_CSP);
    return payload;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.code === 'FST_REQ_FILE_TOO_LARGE' || e.code === 'FST_FILES_LIMIT') {
      reply.code(413).send({ error: { code: 'file_too_large', message: 'The file is too large' } });
      return;
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      reply.code(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message } });
      return;
    }
    console.error(err);
    reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong on the local server. Details are in the terminal.' } });
  });

  await app.register(fastifyMultipart, { limits: { files: 1, fileSize: 1024 * 1024 * 1024, fields: 10 } });

  // Uploaded images, served from the data directory.
  app.get<{ Params: { filename: string } }>('/media/:filename', async (req, reply) => {
    const p = mediaPath(ctx, req.params.filename);
    const mime = mimeForFilename(req.params.filename);
    if (!p || !mime || !fs.existsSync(p)) {
      reply.code(404).send({ error: { code: 'not_found', message: 'Image not found' } });
      return;
    }
    reply.header('Content-Type', mime);
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    return reply.send(fs.createReadStream(p));
  });

  registerRoutes(app, ctx);

  const indexHtml = path.join(config.distDir, 'index.html');
  if (!config.dev && fs.existsSync(indexHtml)) {
    await app.register(fastifyStatic, {
      root: config.distDir,
      prefix: '/',
      wildcard: false,
      index: ['index.html'],
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/media/')) {
      if (!config.dev && fs.existsSync(indexHtml)) {
        reply.header('Cache-Control', 'no-cache');
        return reply.type('text/html').send(fs.readFileSync(indexHtml));
      }
      return reply
        .type('text/html')
        .send(
          config.dev
            ? '<p>Recall API is running. Open the Vite dev server at <a href="http://127.0.0.1:5173">http://127.0.0.1:5173</a>.</p>'
            : '<p>The Recall frontend has not been built yet. Run <code>npm run build</code>, then <code>npm start</code>.</p>',
        );
    }
    reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  return {
    app,
    ctx,
    close: async () => {
      await app.close();
      if (!opts.db) db.close();
    },
  };
}
