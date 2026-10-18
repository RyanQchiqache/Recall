import http from 'node:http';
import { isPortFree } from './ports.ts';
import { hashBuild } from './stale.ts';

export type StartupState = 'starting' | 'building' | 'ready' | 'failed';

/** Shape of GET /api/health. */
export interface Health {
  ok: boolean;
  app: 'recall';
  version: string;
  pid: number;
  dataDir: string;
  port: number;
  buildId: string | null;
  state: StartupState;
  startedAt: string;
  dev?: boolean;
  /** Set by the launcher's own error page, which stands in when the server could not start. */
  launcher?: boolean;
}

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** A tiny loopback HTTP client with full control over headers (fetch would add its own). */
export function request(port: number, urlPath: string, opts: RequestOptions = {}): Promise<HttpResult> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...opts.headers };
  let body = opts.body;
  if (method !== 'GET' && method !== 'HEAD') {
    headers['x-recall-client'] ??= '1';
    headers['content-type'] ??= 'application/json';
    body ??= '{}';
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(opts.timeoutMs ?? 2000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

export async function postJson(port: number, urlPath: string, timeoutMs = 3000): Promise<HttpResult | null> {
  try {
    return await request(port, urlPath, { method: 'POST', timeoutMs });
  } catch {
    return null;
  }
}

export type Probe =
  | { kind: 'free' }
  | { kind: 'unresponsive' }
  | { kind: 'foreign'; detail: string }
  | { kind: 'legacy-recall'; version: string }
  | { kind: 'recall'; health: Health };

/** Works out what, if anything, is listening on a loopback port. */
export async function probePort(port: number, timeoutMs = 2000): Promise<Probe> {
  let res: HttpResult;
  try {
    res = await request(port, '/api/health', { timeoutMs, headers: { accept: 'application/json' } });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') return { kind: 'unresponsive' };
    if (await isPortFree(port)) return { kind: 'free' };
    return { kind: 'foreign', detail: `port in use (${code ?? 'no HTTP answer'})` };
  }
  return classifyHealth(res);
}

export function classifyHealth(res: HttpResult): Probe {
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (res.status === 200 && json && json.app === 'recall' && typeof json.pid === 'number') return { kind: 'recall', health: json as unknown as Health };
  // Recall before the startup work answered { ok: true, version } without app/pid.
  if (res.status === 200 && json && json.ok === true && typeof json.version === 'string' && json.app === undefined) {
    return { kind: 'legacy-recall', version: json.version };
  }
  return { kind: 'foreign', detail: `HTTP ${res.status} from /api/health` };
}

export interface AssetRef {
  url: string;
  type: 'script' | 'style';
}

/** Local JS and CSS referenced by an index.html (scripts, stylesheets, module preloads). */
export function extractAssetRefs(html: string): AssetRef[] {
  const refs: AssetRef[] = [];
  const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(2).find((v) => v !== undefined);
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attr(m[0], 'src');
    if (src) refs.push({ url: src, type: 'script' });
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], 'rel') ?? '').toLowerCase();
    const href = attr(m[0], 'href');
    if (!href) continue;
    if (rel.split(/\s+/).includes('stylesheet')) refs.push({ url: href, type: 'style' });
    else if (rel.split(/\s+/).includes('modulepreload')) refs.push({ url: href, type: 'script' });
  }
  return refs.filter((r) => r.url.startsWith('/') && !r.url.startsWith('//'));
}

export type Verification = { ok: true } | { ok: false; reason: string };

/**
 * Checks what a browser would load: the served index.html must be the current build,
 * and every JS/CSS file it references must answer 200 with the right content type.
 */
export async function verifyFrontend(port: number, expectedBuildId: string | null, timeoutMs = 3000): Promise<Verification> {
  let page: HttpResult;
  try {
    page = await request(port, '/', { timeoutMs, headers: { accept: 'text/html' } });
  } catch {
    return { ok: false, reason: 'the app page did not load' };
  }
  if (page.status !== 200 || !String(page.headers['content-type'] ?? '').includes('text/html')) {
    return { ok: false, reason: `the app page answered HTTP ${page.status}` };
  }
  if (expectedBuildId && hashBuild(page.body) !== expectedBuildId) return { ok: false, reason: 'the server is serving an older page' };
  for (const ref of extractAssetRefs(page.body.toString('utf8'))) {
    let res: HttpResult;
    try {
      res = await request(port, ref.url, { timeoutMs });
    } catch {
      return { ok: false, reason: `${ref.url} did not load` };
    }
    const type = String(res.headers['content-type'] ?? '');
    const want = ref.type === 'script' ? /javascript/ : /text\/css/;
    if (res.status !== 200) return { ok: false, reason: `${ref.url} answered HTTP ${res.status}` };
    if (!want.test(type)) return { ok: false, reason: `${ref.url} has the wrong type (${type || 'none'})` };
  }
  return { ok: true };
}
