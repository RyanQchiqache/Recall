import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type BuiltApp } from '../server/app.ts';
import { APP_VERSION } from '../server/config.ts';
import { buildIdOf, findNewerThan, frontendStatus } from '../server/launch/stale.ts';
import { waitFor } from '../server/launch/system.ts';
import { isAppPage, resolveBuildCommand, Startup, summarizeBuildOutput, swapDist } from '../server/startup.ts';
import { HOST, TEST_PORT, testConfig } from './helpers.ts';
import { age, workspace, writeDist, type Workspace } from './startupFixtures.ts';

const ORIGIN = `http://${HOST}`;
let apps: BuiltApp[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
});

interface Opts {
  env?: NodeJS.ProcessEnv;
  dev?: boolean;
  onShutdown?: () => void;
  openLog?: (file: string) => void;
}

async function boot(w: Workspace, o: Opts = {}) {
  const startup = new Startup({
    projectRoot: w.root,
    distDir: w.distDir,
    dataDir: w.dataDir,
    port: TEST_PORT,
    version: APP_VERSION,
    logPath: w.logPath,
    dev: o.dev,
    inputs: [w.srcDir],
    buildCommand: w.buildCommand,
    env: { ...process.env, ...o.env },
    log: () => {},
  });
  const built = await buildApp({
    config: { ...testConfig(w.dataDir), distDir: w.distDir, dev: o.dev ?? false, logPath: w.logPath },
    startup,
    log: () => {},
    onShutdown: o.onShutdown,
    openLog: o.openLog,
  });
  apps.push(built);
  const get = (url: string) => built.app.inject({ method: 'GET', url, headers: { host: HOST, accept: 'text/html' } });
  const post = (url: string, headers: Record<string, string> = { 'x-recall-client': '1' }) =>
    built.app.inject({ method: 'POST', url, payload: {}, headers: { host: HOST, origin: ORIGIN, ...headers } });
  return { ...built, startup, get, post };
}

function expectStatusPage(res: { statusCode: number; headers: Record<string, unknown>; body: string }) {
  expect(res.statusCode).toBe(503);
  expect(res.headers['content-type']).toContain('text/html');
  expect(res.headers['cache-control']).toBe('no-store');
  const csp = String(res.headers['content-security-policy']);
  expect(csp).toMatch(/script-src 'nonce-[^']+'/);
  expect(csp).not.toContain("'self' 'unsafe-inline'");
  // Self-contained: no external scripts, styles, fonts or images.
  expect(res.body).not.toMatch(/(src|href)=["']https?:/);
  expect(res.body).not.toMatch(/<script[^>]+src=/);
  expect(res.body).toContain('aria-live="polite"');
  expect(res.body).toContain("fetch('/api/startup'");
  expect(res.body).toContain('location.reload()');
}

describe('startup state machine', () => {
  it('becomes ready at once with an up-to-date dist and serves the app', async () => {
    const w = workspace();
    const a = await boot(w);
    expect(a.startup.state).toBe('starting');
    await a.startup.run();
    expect(a.startup.state).toBe('ready');

    const page = await a.get('/');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('data-build="old"');
    const health = (await a.get('/api/health')).json();
    expect(health).toMatchObject({ ok: true, app: 'recall', version: APP_VERSION, pid: process.pid, dataDir: w.dataDir, port: TEST_PORT, state: 'ready', buildId: buildIdOf(w.distDir) });
    expect(Date.parse(health.startedAt)).toBeGreaterThan(0);
  });

  it('builds a missing dist, showing the status page meanwhile, then serves the new app and its assets', async () => {
    const w = workspace({ dist: false });
    const a = await boot(w, { env: { FAKE_BUILD_GATE: w.gate } });
    const running = a.startup.run();
    await waitFor(() => a.startup.state === 'building', 5000, 10);

    const page = await a.get('/');
    expectStatusPage(page);
    expect(page.body).toContain('Preparing Recall for its first start');
    expectStatusPage(await a.get('/study/abc'));
    expect((await a.get('/api/health')).json()).toMatchObject({ state: 'building', buildId: null });
    const status = (await a.get('/api/startup')).json();
    expect(status).toMatchObject({ app: 'recall', state: 'building', error: null, canUsePrevious: false });
    // The API stays usable while the frontend builds.
    expect((await a.get('/api/settings')).statusCode).toBe(200);

    w.openGate();
    await running;
    expect(a.startup.state).toBe('ready');
    expect(fs.existsSync(`${w.distDir}-next`)).toBe(false);
    const app = await a.get('/');
    expect(app.statusCode).toBe(200);
    const js = /src="(\/assets\/[^"]+\.js)"/.exec(app.body)?.[1] as string;
    const asset = await a.get(js);
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('javascript');
    expect((await a.get('/api/health')).json().buildId).toBe(buildIdOf(w.distDir));
  });

  it('rebuilds a stale dist when a source is newer and swaps it in atomically', async () => {
    const w = workspace();
    age(path.join(w.distDir, 'index.html'), 60);
    age(path.join(w.srcDir, 'main.tsx'), 30); // edited after the last build
    const before = buildIdOf(w.distDir);
    expect(frontendStatus(w.distDir, [w.srcDir]).status).toBe('stale');
    const a = await boot(w);
    await a.startup.run();
    expect(a.startup.state).toBe('ready');
    expect(a.startup.buildId).not.toBe(before);
    expect(a.startup.buildId).toBe(buildIdOf(w.distDir));
    expect(fs.existsSync(`${w.distDir}-old`)).toBe(false);
    expect(fs.existsSync(path.join(w.distDir, 'assets', 'app-old.js'))).toBe(false);
    const page = await a.get('/');
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('data-build="old"');
    // The new build is dated by its start, so sources edited during the build still count as newer.
    expect(frontendStatus(w.distDir, [w.srcDir]).status).toBe('fresh');
  });

  it('reports a failed build with the error and log tail, keeps the previous dist, and retries after a fix', async () => {
    const w = workspace();
    age(path.join(w.srcDir, 'main.tsx'), -5);
    w.buildFails();
    const oldHtml = fs.readFileSync(path.join(w.distDir, 'index.html'), 'utf8');
    const a = await boot(w);
    await a.startup.run();

    expect(a.startup.state).toBe('failed');
    const status = (await a.get('/api/startup')).json();
    expect(status.error.summary).toBe('src/main.tsx:3:5: ERROR: Unexpected "}"');
    expect(status.buildLog).toContain('error during build:');
    expect(status.canUsePrevious).toBe(true);
    expect(status.report).toContain(`Node.js:     ${process.version}`);
    expect(status.report).toContain(`Data folder: ${w.dataDir}`);
    expect(status.report).toContain('ERROR: Unexpected');
    expect(fs.readFileSync(path.join(w.distDir, 'index.html'), 'utf8')).toBe(oldHtml);
    expect(fs.existsSync(`${w.distDir}-next`)).toBe(false);

    const page = await a.get('/');
    expectStatusPage(page);
    for (const text of ['The update could not be built', 'Unexpected', 'Retry', 'Open log', 'Copy details', 'Open the previous version']) expect(page.body).toContain(text);

    // Retry is a protected mutation like the rest of the API.
    expect((await a.post('/api/startup/retry', {})).statusCode).toBe(403);
    expect((await a.post('/api/startup/retry', { 'x-recall-client': '1', origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await a.post('/api/startup/retry', { 'x-recall-client': '1', 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect(a.startup.state).toBe('failed');

    w.buildOk();
    const retry = await a.post('/api/startup/retry');
    expect(retry.statusCode).toBe(200);
    expect(['starting', 'building']).toContain(retry.json().state);
    expect(await waitFor(() => a.startup.state === 'ready', 10_000, 20)).toBe(true);
    expect((await a.get('/')).body).not.toContain('data-build="old"');
  });

  it('can open the previous version after a failed rebuild', async () => {
    const w = workspace();
    age(path.join(w.srcDir, 'main.tsx'), -5);
    w.buildFails();
    const a = await boot(w);
    await a.startup.run();
    const res = await a.post('/api/startup/use-previous');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'ready', usingPrevious: true });
    expect((await a.get('/')).body).toContain('data-build="old"');
  });

  it('fails clearly when the build fails and there is no previous dist', async () => {
    const w = workspace({ dist: false });
    w.buildFails();
    const a = await boot(w);
    await a.startup.run();
    const status = (await a.get('/api/startup')).json();
    expect(status).toMatchObject({ state: 'failed', canUsePrevious: false });
    expect(status.error.hint).toContain('needs a successful build');
    expect(fs.existsSync(w.distDir)).toBe(false);
    const page = await a.get('/');
    expectStatusPage(page);
    expect(page.body).toContain('Unexpected');
    expect((await a.post('/api/startup/use-previous')).statusCode).toBe(409);
  });

  it('explains a missing build tool instead of crashing', async () => {
    const w = workspace({ dist: false });
    expect(() => resolveBuildCommand(w.root, path.join(w.root, 'dist-next'))).toThrow(/node_modules\/vite is missing/);
    const startup = new Startup({ projectRoot: w.root, distDir: w.distDir, dataDir: w.dataDir, port: TEST_PORT, version: APP_VERSION, logPath: w.logPath, inputs: [w.srcDir], env: {}, log: () => {} });
    await startup.run();
    expect(startup.status().error?.summary).toContain('node_modules/vite is missing');
    expect(startup.status().error?.hint).toContain('npm ci');
  });

  it('never builds in development mode', async () => {
    const w = workspace({ dist: false });
    const a = await boot(w, { dev: true });
    await a.startup.run();
    expect(a.startup.state).toBe('ready');
    expect(fs.existsSync(w.distDir)).toBe(false);
  });
});

describe('startup endpoints', () => {
  it('opens the log through the OS only for same-origin app requests', async () => {
    const w = workspace();
    const openLog = vi.fn();
    const a = await boot(w, { openLog });
    expect((await a.post('/api/startup/open-log', {})).statusCode).toBe(403);
    expect(openLog).not.toHaveBeenCalled();
    const res = await a.post('/api/startup/open-log');
    expect(res.statusCode).toBe(200);
    expect(openLog).toHaveBeenCalledWith(w.logPath);
  });

  it('shuts down on request, with the usual header and origin checks', async () => {
    const w = workspace();
    const onShutdown = vi.fn();
    const a = await boot(w, { onShutdown });
    expect((await a.post('/api/system/shutdown', {})).statusCode).toBe(403);
    expect((await a.post('/api/system/shutdown', { 'x-recall-client': '1', origin: 'http://evil.example' })).statusCode).toBe(403);
    const bad = await a.app.inject({ method: 'POST', url: '/api/system/shutdown', payload: {}, headers: { host: 'evil.example:80', 'x-recall-client': '1' } });
    expect(bad.statusCode).toBe(421);
    await new Promise((r) => setTimeout(r, 50));
    expect(onShutdown).not.toHaveBeenCalled();
    const res = await a.post('/api/system/shutdown');
    expect(res.json()).toMatchObject({ ok: true, pid: process.pid });
    expect(await waitFor(() => onShutdown.mock.calls.length === 1, 2000, 10)).toBe(true);
  });

  it('keeps media and assets out of the status page gate', () => {
    expect(isAppPage('/')).toBe(true);
    expect(isAppPage('/courses/123?tab=cards')).toBe(true);
    expect(isAppPage('/index.html')).toBe(true);
    expect(isAppPage('/api/health')).toBe(false);
    expect(isAppPage('/media/abc.png')).toBe(false);
    expect(isAppPage('/assets/index-123.js')).toBe(false);
    expect(isAppPage('/favicon.svg')).toBe(false);
  });
});

describe('startup helpers', () => {
  it('finds the first input newer than dist, including deletions via directory mtimes', () => {
    const w = workspace();
    const ref = fs.statSync(path.join(w.distDir, 'index.html')).mtimeMs;
    expect(findNewerThan([w.srcDir, path.join(w.root, 'missing.ts')], ref)).toBeNull();
    fs.mkdirSync(path.join(w.srcDir, 'deep', 'er'), { recursive: true });
    fs.writeFileSync(path.join(w.srcDir, 'deep', 'er', 'x.ts'), '');
    age(path.join(w.srcDir, 'deep', 'er', 'x.ts'), -10);
    expect(findNewerThan([w.srcDir], ref)).not.toBeNull();
    expect(frontendStatus(path.join(w.root, 'nope'), [w.srcDir]).status).toBe('missing');
  });

  it('summarizes build output to the actionable line', () => {
    expect(summarizeBuildOutput(['error during build:', '[vite]: Rollup failed to resolve import "x" from "src/a.ts".', '    at foo'], 1, null)).toBe(
      '[vite]: Rollup failed to resolve import "x" from "src/a.ts".',
    );
    expect(summarizeBuildOutput(['x', 'TypeError: boom'], 1, null)).toBe('TypeError: boom');
    expect(summarizeBuildOutput([], 3, null)).toBe('The build exited with code 3.');
  });

  it('swaps dist folders and keeps the old one if the new one cannot be moved in', () => {
    const w = workspace();
    const next = `${w.distDir}-next`;
    writeDist(next, 'new');
    swapDist(w.distDir, next);
    expect(fs.readFileSync(path.join(w.distDir, 'index.html'), 'utf8')).toContain('data-build="new"');
    expect(fs.existsSync(next)).toBe(false);
    expect(() => swapDist(w.distDir, next)).toThrow();
    expect(fs.readFileSync(path.join(w.distDir, 'index.html'), 'utf8')).toContain('data-build="new"');
  });
});
