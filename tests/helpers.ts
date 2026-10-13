import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type BuiltApp } from '../server/app.ts';
import { pathsFor, type AppConfig } from '../server/config.ts';
import { mulberry32 } from '../shared/random.ts';

export const TEST_PORT = 4999;
export const HOST = `127.0.0.1:${TEST_PORT}`;

export interface TestClock {
  t: Date;
  set(iso: string): void;
  advance(ms: number): void;
}

export function makeClock(iso = '2026-10-13T08:00:00.000Z'): TestClock {
  const c: TestClock = {
    t: new Date(iso),
    set(v) {
      c.t = new Date(v);
    },
    advance(ms) {
      c.t = new Date(c.t.getTime() + ms);
    },
  };
  return c;
}

export function tempDir(prefix = 'recall-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testConfig(dataDir: string): AppConfig {
  return {
    ...pathsFor(dataDir),
    host: '127.0.0.1',
    port: TEST_PORT,
    dev: false,
    distDir: path.join(dataDir, 'no-dist'),
    extraOrigins: [],
  };
}

export interface TestApp extends BuiltApp {
  dataDir: string;
  clock: TestClock;
  api: <T = any>(method: string, url: string, body?: unknown) => Promise<{ status: number; body: T }>;
  upload: <T = any>(url: string, filename: string, content: Buffer, mime?: string) => Promise<{ status: number; body: T }>;
  raw: (method: string, url: string) => Promise<{ status: number; buffer: Buffer; headers: Record<string, unknown> }>;
}

export async function makeApp(opts: { dataDir?: string; clock?: TestClock; seed?: number } = {}): Promise<TestApp> {
  const dataDir = opts.dataDir ?? tempDir();
  const clock = opts.clock ?? makeClock();
  const built = await buildApp({ config: testConfig(dataDir), now: () => new Date(clock.t), random: mulberry32(opts.seed ?? 42), log: () => {} });
  const api: TestApp['api'] = async (method, url, body) => {
    const res = await built.app.inject({
      method: method as 'GET',
      url,
      payload: body === undefined ? (method === 'GET' || method === 'DELETE' ? undefined : {}) : (body as object),
      headers: { host: HOST, 'x-recall-client': '1' },
    });
    let parsed: unknown = null;
    try {
      parsed = res.json();
    } catch {
      parsed = res.body;
    }
    return { status: res.statusCode, body: parsed as never };
  };
  const upload: TestApp['upload'] = async (url, filename, content, mime = 'application/octet-stream') => {
    const boundary = '----recalltest' + Math.random().toString(16).slice(2);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await built.app.inject({
      method: 'POST',
      url,
      payload,
      headers: { host: HOST, 'x-recall-client': '1', 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    return { status: res.statusCode, body: res.json() as never };
  };
  const raw: TestApp['raw'] = async (method, url) => {
    const res = await built.app.inject({ method: method as 'GET', url, headers: { host: HOST } });
    return { status: res.statusCode, buffer: res.rawPayload, headers: res.headers };
  };
  return { ...built, dataDir, clock, api, upload, raw };
}

/** Create program → semester → course → sections with N cards each. */
export async function seedHierarchy(app: TestApp, sections: number[] = [5]) {
  const program = (await app.api('POST', '/api/programs', { title: 'M.Sc. Test' })).body;
  const semester = (await app.api('POST', '/api/semesters', { programId: program.id, title: 'WS 26/27' })).body;
  const course = (await app.api('POST', '/api/courses', { semesterId: semester.id, title: 'Course A' })).body;
  const sectionList: { id: string; cardIds: string[] }[] = [];
  for (const [i, n] of sections.entries()) {
    const section = (await app.api('POST', '/api/sections', { courseId: course.id, title: `Week ${i + 1}` })).body;
    const cardIds: string[] = [];
    for (let j = 0; j < n; j++) {
      const card = (await app.api('POST', '/api/cards', { sectionId: section.id, front: `Q ${i + 1}.${j + 1}`, back: `A ${i + 1}.${j + 1}` })).body;
      cardIds.push(card.id);
    }
    sectionList.push({ id: section.id, cardIds });
  }
  return { program, semester, course, sections: sectionList };
}

export function sessionRequest(scope: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    mode: 'scheduled',
    scope,
    filters: { includeNew: true, tags: [], bookmarkedOnly: false, status: 'any', weakBasis: 'all' },
    ordering: 'default',
    size: 30,
    maxAttempts: 3,
    ...extra,
  };
}

let keyCounter = 0;
export function key(): string {
  keyCounter++;
  return `test-key-${Date.now()}-${keyCounter}`;
}

/** Reveal and rate the current card. */
export async function revealAndRate(app: TestApp, sessionId: string, rating: number) {
  const s = (await app.api('GET', `/api/sessions/${sessionId}`)).body;
  if (!s.current) throw new Error(`No current card (waiting=${s.waiting}, status=${s.status})`);
  const r1 = await app.api('POST', `/api/sessions/${sessionId}/reveal`, { revision: s.revision });
  if (r1.status !== 200) throw new Error(`reveal failed: ${JSON.stringify(r1.body)}`);
  const r2 = await app.api('POST', `/api/sessions/${sessionId}/rate`, { rating, idempotencyKey: key(), revision: r1.body.revision });
  if (r2.status !== 200) throw new Error(`rate failed: ${JSON.stringify(r2.body)}`);
  return { cardId: s.current.cardId as string, state: r2.body.state };
}
