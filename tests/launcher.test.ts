import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_VERSION, PROJECT_ROOT } from '../server/config.ts';
import { assessHealth, decide, type Installed } from '../server/launch/decide.ts';
import { acquireLock, LockTimeoutError } from '../server/launch/lock.ts';
import { getFreePort, isPortFree, pickPort } from '../server/launch/ports.ts';
import { extractAssetRefs, probePort, request, type Health } from '../server/launch/probe.ts';
import { readServerInfo } from '../server/launch/serverInfo.ts';
import { buildIdOf } from '../server/launch/stale.ts';
import { isPidAlive, waitFor } from '../server/launch/system.ts';
import { defaultSpawnServer, explainCrash, launch, stop, type LaunchOptions, type SpawnArgs } from '../server/launcher.ts';
import { tempDir } from './helpers.ts';
import { age, workspace, writeDist, type Workspace } from './startupFixtures.ts';

interface Env {
  w: Workspace;
  opts: Partial<LaunchOptions>;
  opened: string[];
  said: string[];
  spawned: ChildProcess[];
}

const envs: Env[] = [];
const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const e of envs.splice(0)) {
    await stop(e.opts);
    for (const c of e.spawned) if (c.pid && isPidAlive(c.pid)) process.kill(c.pid, 'SIGKILL');
  }
});

async function setup(o: { dist?: boolean } = {}): Promise<Env> {
  const w = workspace({ dist: o.dist });
  const port = await getFreePort();
  const fallbackPorts = [await getFreePort(), await getFreePort()].filter((p) => p !== port);
  const e: Env = { w, opened: [], said: [], spawned: [], opts: {} };
  e.opts = {
    dataDir: w.dataDir,
    distDir: w.distDir,
    logPath: w.logPath,
    port,
    fallbackPorts,
    staleInputs: [w.srcDir],
    serverInputs: [],
    env: { RECALL_BUILD_COMMAND: JSON.stringify(w.buildCommand) },
    open: (url) => e.opened.push(url),
    openLog: () => {},
    say: (line) => e.said.push(line),
    spawnServer: (a: SpawnArgs) => {
      const c = defaultSpawnServer(a);
      e.spawned.push(c);
      return c;
    },
    startTimeoutMs: 20_000,
  };
  envs.push(e);
  return e;
}

async function health(port: number): Promise<Health> {
  const p = await probePort(port);
  if (p.kind !== 'recall') throw new Error(`no Recall on ${port}: ${p.kind}`);
  return p.health;
}

async function waitReady(port: number) {
  expect(await waitFor(async () => (await health(port).catch(() => null))?.state === 'ready', 15_000, 50)).toBe(true);
}

/** A stand-in for an old Recall server: right health answer, but it serves HTML whose assets 404. */
function fakeStaleServer(port: number, h: Omit<Health, 'port'>, html: string): Promise<{ shutdowns: number; close: () => Promise<void> }> {
  const state = { shutdowns: 0, close: async () => {} };
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/health') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...h, port }));
    if (req.url === '/api/system/shutdown' && req.method === 'POST') {
      state.shutdowns++;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      srv.close();
      srv.closeAllConnections();
      return;
    }
    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  });
  state.close = () => new Promise((r) => (srv.listening ? srv.close(() => r()) : r()));
  closers.push(state.close);
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(state)));
}

describe('launcher', () => {
  it('starts a fresh server once dist is current, records it and opens the browser', async () => {
    const e = await setup();
    const r = await launch(e.opts);
    expect(r).toMatchObject({ action: 'started', port: e.opts.port });
    expect(e.opened).toEqual([`http://127.0.0.1:${e.opts.port}/`]);
    expect(e.spawned).toHaveLength(1);
    await waitReady(e.opts.port as number);
    const h = await health(e.opts.port as number);
    expect(h).toMatchObject({ app: 'recall', version: APP_VERSION, buildId: buildIdOf(e.w.distDir), dataDir: e.w.dataDir });
    expect(readServerInfo(e.w.dataDir)).toMatchObject({ pid: h.pid, port: e.opts.port, version: APP_VERSION });
    expect(fs.existsSync(path.join(e.w.dataDir, 'launch.lock'))).toBe(false);
  });

  it('reuses an already-running healthy server without spawning another', async () => {
    const e = await setup();
    await launch(e.opts);
    await waitReady(e.opts.port as number);
    const pid = (await health(e.opts.port as number)).pid;
    for (let i = 0; i < 2; i++) {
      const r = await launch(e.opts);
      expect(r.action).toBe('reused');
    }
    expect(e.spawned).toHaveLength(1);
    expect(e.opened).toHaveLength(3);
    expect((await health(e.opts.port as number)).pid).toBe(pid);
  });

  it('shows the status page from a server that is building a missing dist, then the app', async () => {
    const e = await setup({ dist: false });
    e.opts.env = { ...e.opts.env, FAKE_BUILD_GATE: e.w.gate };
    const r = await launch(e.opts);
    expect(r.action).toBe('started');
    const port = e.opts.port as number;
    expect(await waitFor(async () => (await health(port)).state === 'building', 5000, 20)).toBe(true);
    const page = await request(port, '/', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(503);
    expect(page.body.toString()).toContain('Preparing Recall for its first start');
    // A second launch while it builds opens the same server instead of restarting it.
    expect((await launch(e.opts)).action).toBe('reused');
    e.w.openGate();
    await waitReady(port);
    expect((await request(port, '/')).status).toBe(200);
    expect(e.spawned).toHaveLength(1);
  });

  it('restarts a running server whose build no longer matches dist on disk', async () => {
    const e = await setup();
    await launch(e.opts);
    const port = e.opts.port as number;
    await waitReady(port);
    const oldPid = (await health(port)).pid;
    writeDist(e.w.distDir, 'other'); // e.g. `npm run build` ran while Recall was open
    const r = await launch(e.opts);
    expect(r).toMatchObject({ action: 'started', port });
    expect(e.said.join('\n')).toMatch(/different build/);
    expect(isPidAlive(oldPid)).toBe(false);
    await waitReady(port);
    const h = await health(port);
    expect(h.pid).not.toBe(oldPid);
    expect(h.buildId).toBe(buildIdOf(e.w.distDir));
    expect(e.spawned).toHaveLength(2);
  });

  it('restarts a server whose sources changed so it rebuilds', async () => {
    const e = await setup();
    await launch(e.opts);
    const port = e.opts.port as number;
    await waitReady(port);
    const before = buildIdOf(e.w.distDir);
    age(path.join(e.w.distDir, 'index.html'), 60);
    age(path.join(e.w.srcDir, 'main.tsx'), 30);
    expect((await launch(e.opts)).action).toBe('started');
    expect(e.said.join('\n')).toMatch(/updated since the last build/);
    await waitReady(port);
    expect((await health(port)).buildId).not.toBe(before);
    expect((await health(port)).buildId).toBe(buildIdOf(e.w.distDir));
  });

  it('replaces a stale server whose assets return 404', async () => {
    const e = await setup();
    const port = e.opts.port as number;
    const html = fs.readFileSync(path.join(e.w.distDir, 'index.html'), 'utf8');
    const fake = await fakeStaleServer(
      port,
      { ok: true, app: 'recall', version: APP_VERSION, pid: process.pid, dataDir: e.w.dataDir, buildId: buildIdOf(e.w.distDir), state: 'ready', startedAt: new Date().toISOString() },
      html,
    );
    const r = await launch(e.opts);
    expect(fake.shutdowns).toBe(1);
    expect(e.said.join('\n')).toMatch(/app-old\.js answered HTTP 404/);
    expect(r).toMatchObject({ action: 'started', port });
    await waitReady(port);
    expect((await health(port)).pid).not.toBe(process.pid);
    const asset = await request(port, '/assets/app-old.js');
    expect(asset.status).toBe(200);
  });

  it('falls back to the next free port when another program holds the configured one', async () => {
    const e = await setup();
    const port = e.opts.port as number;
    const other = http.createServer((_req, res) => res.writeHead(404, { 'content-type': 'text/plain' }).end('not recall'));
    await new Promise<void>((r) => other.listen(port, '127.0.0.1', () => r()));
    closers.push(() => new Promise((r) => other.close(() => r())));

    const r = await launch(e.opts);
    const fallback = (e.opts.fallbackPorts as number[])[0];
    expect(r).toMatchObject({ action: 'started', port: fallback });
    expect(e.said.join('\n')).toMatch(new RegExp(`Port ${port} is in use.*uses port ${fallback}`));
    expect(readServerInfo(e.w.dataDir)?.port).toBe(fallback);
    expect(e.opened).toEqual([`http://127.0.0.1:${fallback}/`]);
    await waitReady(fallback);
    // The next launch finds it through server.json.
    expect(await launch(e.opts)).toMatchObject({ action: 'reused', port: fallback });
    expect(e.spawned).toHaveLength(1);
  });

  it('reports a clear error when no port is free', async () => {
    const e = await setup();
    const servers: http.Server[] = [];
    for (const p of [e.opts.port as number, ...(e.opts.fallbackPorts as number[])]) {
      const s = http.createServer((_q, res) => res.end('x'));
      await new Promise<void>((r) => s.listen(p, '127.0.0.1', () => r()));
      servers.push(s);
      closers.push(() => new Promise((r) => s.close(() => r())));
    }
    const r = await launch(e.opts);
    expect(r.action).toBe('failed');
    expect(r.reason).toMatch(/all in use/);
    expect(e.spawned).toHaveLength(0);
  });

  it('serialises simultaneous launches so only one server starts', async () => {
    const e = await setup();
    const results = await Promise.all([launch(e.opts), launch(e.opts), launch(e.opts)]);
    expect(results.map((r) => r.action).sort()).toEqual(['reused', 'reused', 'started']);
    expect(e.spawned).toHaveLength(1);
    expect(new Set(results.map((r) => ('port' in r ? r.port : null)))).toEqual(new Set([e.opts.port]));
  });

  it('--stop shuts the server down gracefully and removes server.json', async () => {
    const e = await setup();
    await launch(e.opts);
    const port = e.opts.port as number;
    await waitReady(port);
    const pid = (await health(port)).pid;
    const r = await stop(e.opts);
    expect(r).toMatchObject({ ok: true, stopped: true, message: 'Recall stopped.' });
    expect(await isPortFree(port)).toBe(true);
    expect(isPidAlive(pid)).toBe(false);
    expect(readServerInfo(e.w.dataDir)).toBeNull();
    expect(fs.readFileSync(e.w.logPath, 'utf8')).toContain('Recall stopped.');
    expect(await stop(e.opts)).toMatchObject({ ok: true, stopped: false, message: 'Recall was not running.' });
  });

  it('serves its own error page when the server dies before listening, and Retry recovers', async () => {
    const e = await setup();
    const port = e.opts.port as number;
    let broken = true;
    e.opts.spawnServer = (a: SpawnArgs) => {
      if (!broken) {
        const c = defaultSpawnServer(a);
        e.spawned.push(c);
        return c;
      }
      const fd = fs.openSync(a.logPath, 'a');
      const c = spawn(process.execPath, ['-e', "console.error('SqliteError: file is not a database'); console.error('    at Database (x.js:1:1)'); process.exit(1)"], { stdio: ['ignore', fd, fd] });
      fs.closeSync(fd);
      return c;
    };
    const r = await launch(e.opts);
    expect(r.action).toBe('failed');
    if (r.action !== 'failed' || !r.fallback) throw new Error('expected an error page');
    closers.push(() => r.fallback?.close());
    expect(r.reason).toBe('SqliteError: file is not a database');
    expect(e.opened).toEqual([`http://127.0.0.1:${port}/`]);

    const page = await request(port, '/', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(503);
    const body = page.body.toString();
    for (const t of ['Recall could not start', 'file is not a database', 'Retry', 'Open log', 'Copy details', 'snapshot']) expect(body).toContain(t);
    expect(String(page.headers['content-security-policy'])).toMatch(/script-src 'nonce-/);
    expect((await health(port)).launcher).toBe(true);
    expect((await request(port, '/api/startup/retry', { method: 'POST', headers: { 'x-recall-client': '0' } })).status).toBe(403);
    expect((await request(port, '/', { headers: { host: 'evil.example' } })).status).toBe(421);

    broken = false;
    const retry = await request(port, '/api/startup/retry', { method: 'POST' });
    expect(retry.status).toBe(200);
    expect(await r.fallback.done).toBe('recovered');
    await waitReady(port);
    expect((await health(port)).launcher).toBeUndefined();
  });
});

describe('launcher building blocks', () => {
  const installed: Installed = { version: '1.0.0', dataDir: '/data', buildId: 'abc', frontendStale: false, serverCodeMtimeMs: 0 };
  const h = (over: Partial<Health> = {}): Health => ({ ok: true, app: 'recall', version: '1.0.0', pid: 1, dataDir: '/data', port: 4317, buildId: 'abc', state: 'ready', startedAt: new Date(1000).toISOString(), ...over });

  it('assesses running servers', () => {
    expect(assessHealth(h(), installed)).toEqual({ action: 'verify-assets' });
    expect(assessHealth(h({ version: '0.9.0' }), installed).action).toBe('restart');
    expect(assessHealth(h({ buildId: 'old' }), installed).action).toBe('restart');
    expect(assessHealth(h(), { ...installed, frontendStale: true }).action).toBe('restart');
    expect(assessHealth(h(), { ...installed, serverCodeMtimeMs: 2000 }).action).toBe('restart');
    expect(assessHealth(h({ state: 'building', buildId: null }), installed).action).toBe('reuse');
    expect(assessHealth(h({ state: 'failed' }), installed)).toMatchObject({ action: 'reuse', retry: true });
  });

  it('decides between reuse, restart and start', () => {
    const recall = { kind: 'recall' as const, health: h() };
    expect(decide([{ port: 4317, probe: recall, assessment: { action: 'reuse', reason: 'ok' } }], 4317, installed, null)).toMatchObject({ action: 'reuse', port: 4317 });
    expect(decide([{ port: 4318, probe: recall, assessment: { action: 'restart', reason: 'stale' } }, { port: 4317, probe: { kind: 'free' } }], 4317, installed, null)).toMatchObject({ action: 'restart', port: 4318, pid: 1 });
    expect(decide([{ port: 4317, probe: { kind: 'free' } }], 4317, installed, null)).toMatchObject({ action: 'start', port: 4317 });
    expect(decide([{ port: 4317, probe: { kind: 'foreign', detail: 'x' } }], 4317, installed, 4319)).toMatchObject({ action: 'start', port: 4319 });
    expect(decide([{ port: 4317, probe: { kind: 'recall', health: h({ dataDir: '/elsewhere' }) } }], 4317, installed, 4318)).toMatchObject({ action: 'start', port: 4318 });
    expect(decide([{ port: 4317, probe: { kind: 'foreign', detail: 'x' } }], 4317, installed, null).action).toBe('fail');
  });

  it('extracts the JS and CSS a page loads', () => {
    const html = '<script type="module" crossorigin src="/assets/a.js"></script><link rel="modulepreload" href="/assets/b.js"><link rel=stylesheet href=/assets/c.css><link rel="icon" href="/favicon.svg"><script src="https://cdn.example/x.js"></script>';
    expect(extractAssetRefs(html)).toEqual([
      { url: '/assets/a.js', type: 'script' },
      { url: '/assets/b.js', type: 'script' },
      { url: '/assets/c.css', type: 'style' },
    ]);
  });

  it('picks the first free fallback port', async () => {
    const taken = new Set([4318, 4319]);
    expect(await pickPort([4318, 4319, 4320], async (p) => !taken.has(p))).toBe(4320);
    expect(await pickPort([4318], async () => false)).toBeNull();
  });

  it('breaks a lock whose owner died, but waits for a live one', async () => {
    const dir = path.join(tempDir(), 'launch.lock');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 999_999_999, createdAt: Date.now(), token: 'dead' }));
    const lock = await acquireLock(dir, { timeoutMs: 1000 });
    expect(lock.owner.pid).toBe(process.pid);
    await expect(acquireLock(dir, { timeoutMs: 200, pollMs: 20 })).rejects.toBeInstanceOf(LockTimeoutError);
    lock.release();
    expect(fs.existsSync(dir)).toBe(false);
    // Too old counts as abandoned even if the pid is alive (pid reuse).
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() - 3 * 60_000, token: 'old' }));
    (await acquireLock(dir, { timeoutMs: 1000 })).release();
  });

  it('explains common crashes in plain language', () => {
    expect(explainCrash(['Error: The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127'], '/d').hint).toMatch(/npm rebuild better-sqlite3/);
    expect(explainCrash(['TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"'], '/d').hint).toMatch(/Node\.js 24/);
    expect(explainCrash(['SqliteError: database disk image is malformed'], '/d').hint).toMatch(/snapshot/);
  });
});

describe('macOS app wrapper', () => {
  it.skipIf(process.platform !== 'darwin')('generates launch scripts that parse and explain a missing or old Node.js', () => {
    const script = path.join(PROJECT_ROOT, 'scripts', 'make-mac-app.sh');
    // Never let a test write to /Applications: only run a script that honours DEST.
    expect(fs.readFileSync(script, 'utf8')).toContain('DEST="${DEST:-/Applications}"');
    const dest = tempDir('recall-app-');
    execFileSync('zsh', [script], { env: { ...process.env, DEST: dest, RECALL_SKIP_ICON: '1' }, stdio: 'pipe' });
    const launchScript = path.join(dest, 'Recall.app', 'Contents', 'MacOS', 'launch');
    const stopScript = path.join(dest, 'Stop Recall.app', 'Contents', 'MacOS', 'launch');
    for (const s of [launchScript, stopScript]) {
      execFileSync('zsh', ['-n', s]);
      expect(fs.statSync(s).mode & 0o111).not.toBe(0);
    }
    const text = fs.readFileSync(launchScript, 'utf8');
    expect(text).toContain('server/launcher.ts');
    expect(text).toContain('/opt/homebrew/opt/node@24/bin');
    expect(text).toContain('Library/Logs/Recall.log');
    expect(fs.readFileSync(stopScript, 'utf8')).toContain('--stop');
    expect(fs.readFileSync(path.join(dest, 'Recall.app', 'Contents', 'Info.plist'), 'utf8')).toContain('<string>launch</string>');

    // Run the launch script with only an old Node.js available and a stub osascript that records the dialog.
    const bin = tempDir('recall-bin-');
    const record = path.join(bin, 'dialog.txt');
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho v20.11.1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'osascript'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${record}"; done\necho "button returned:OK"\n`, { mode: 0o755 });
    let code = 0;
    try {
      execFileSync('zsh', [launchScript], { env: { HOME: bin, PATH: `${bin}:/usr/bin:/bin`, RECALL_NODE_CANDIDATES: path.join(bin, 'node') }, stdio: 'pipe' });
    } catch (err) {
      code = (err as { status: number }).status;
    }
    expect(code).toBe(1);
    const dialog = fs.readFileSync(record, 'utf8');
    expect(dialog).toContain('Recall needs Node.js 24 to run');
    expect(dialog).toContain('20.11.1');
    expect(dialog).toContain('brew install node@24');
    expect(dialog).toContain('Open download page');
  });
});
