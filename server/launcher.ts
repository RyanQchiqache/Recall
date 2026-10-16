/**
 * Recall launcher: starts Recall once, reuses a healthy instance, replaces a stale one, and explains failures.
 *
 *   node server/launcher.ts [--stop] [--port N] [--data-dir D] [--no-open]
 *
 * All decisions are made by small, testable modules in server/launch/. This file wires them together.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, PROJECT_ROOT, defaultDataDir, defaultLogPath } from './config.ts';
import { assessHealth, decide, isOurs, sameDir, type Candidate, type Installed } from './launch/decide.ts';
import { acquireLock, LockTimeoutError } from './launch/lock.ts';
import { DEFAULT_PORT, FALLBACK_PORTS, isPortFree, pickPort } from './launch/ports.ts';
import { postJson, probePort, verifyFrontend, type Health } from './launch/probe.ts';
import { readServerInfo, removeServerInfo } from './launch/serverInfo.ts';
import { buildIdOf, frontendStatus, newestMtime, staleInputs as defaultStaleInputs } from './launch/stale.ts';
import { formatReport, newNonce, renderStatusPage, statusPageCsp, type StartupStatus } from './launch/statusPage.ts';
import {
  fileSize,
  isPidAlive,
  isRecallProcess,
  killPid,
  openLogFile,
  openWithOs,
  pidListeningOn,
  readTail,
  waitFor,
} from './launch/system.ts';

export interface SpawnArgs {
  port: number;
  dataDir: string;
  logPath: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
}

export interface LaunchOptions {
  dataDir: string;
  port: number;
  fallbackPorts: number[];
  distDir: string;
  logPath: string;
  projectRoot: string;
  version: string;
  openBrowser: boolean;
  /** Extra environment for the server process. */
  env: NodeJS.ProcessEnv;
  /** Frontend staleness inputs (also passed to the server as RECALL_STALE_INPUTS when set). */
  staleInputs?: string[];
  /** Server code whose changes make a running server stale. */
  serverInputs: string[];
  startTimeoutMs: number;
  healthTimeoutMs: number;
  lockTimeoutMs: number;
  lockStaleMs: number;
  /** The launcher's own error page exits after this long without user activity. */
  fallbackIdleMs: number;
  /**
   * Serve the error page from a separate, detached process so the launcher can exit (the CLI does this:
   * macOS ignores a second click on Recall.app while its launch script is still running).
   */
  detachErrorPage: boolean;
  open: (url: string) => void;
  openLog: (file: string) => void;
  spawnServer: (args: SpawnArgs) => ChildProcess;
  say: (line: string) => void;
}

export type LaunchResult =
  | { action: 'reused' | 'started'; port: number; url: string; reason: string }
  | { action: 'failed'; reason: string; port?: number; fallback?: FallbackPage; errorPage?: boolean };

export interface StopResult {
  ok: boolean;
  stopped: boolean;
  message: string;
}

const urlFor = (port: number) => `http://127.0.0.1:${port}/`;

function appendLog(file: string, line: string) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    /* logging is best-effort */
  }
}

export function defaultSpawnServer(a: SpawnArgs): ChildProcess {
  fs.mkdirSync(path.dirname(a.logPath), { recursive: true });
  const fd = fs.openSync(a.logPath, 'a');
  try {
    return spawn(process.execPath, [path.join(a.projectRoot, 'server', 'index.ts'), '--no-open', '--port', String(a.port), '--data-dir', a.dataDir], {
      cwd: a.projectRoot,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: a.env,
      windowsHide: true,
    });
  } finally {
    fs.closeSync(fd);
  }
}

/** Fills in defaults for everything not given (CLI flags and environment come in through `partial`). */
export function resolveOptions(partial: Partial<LaunchOptions> = {}, env: NodeJS.ProcessEnv = process.env): LaunchOptions {
  const projectRoot = partial.projectRoot ?? PROJECT_ROOT;
  const dataDir = path.resolve(partial.dataDir ?? env.RECALL_DATA_DIR ?? defaultDataDir());
  const logPath = path.resolve(partial.logPath ?? env.RECALL_LOG_FILE ?? defaultLogPath(dataDir));
  const say =
    partial.say ??
    ((line: string) => {
      appendLog(logPath, `[launcher ${new Date().toISOString()}] ${line}`);
      if (process.stdout.isTTY) console.log(`  ${line}`);
    });
  return {
    dataDir,
    port: partial.port ?? Number(env.RECALL_PORT ?? DEFAULT_PORT),
    fallbackPorts: partial.fallbackPorts ?? FALLBACK_PORTS,
    distDir: path.resolve(partial.distDir ?? env.RECALL_DIST_DIR ?? path.join(projectRoot, 'dist')),
    logPath,
    projectRoot,
    version: partial.version ?? APP_VERSION,
    openBrowser: partial.openBrowser ?? true,
    env: partial.env ?? {},
    staleInputs: partial.staleInputs,
    serverInputs: partial.serverInputs ?? ['server', 'shared', 'package.json'].map((p) => path.join(projectRoot, p)),
    startTimeoutMs: partial.startTimeoutMs ?? 90_000,
    healthTimeoutMs: partial.healthTimeoutMs ?? 2_000,
    lockTimeoutMs: partial.lockTimeoutMs ?? 150_000,
    lockStaleMs: partial.lockStaleMs ?? 120_000,
    fallbackIdleMs: partial.fallbackIdleMs ?? 10 * 60_000,
    detachErrorPage: partial.detachErrorPage ?? false,
    open: partial.open ?? openWithOs,
    openLog: partial.openLog ?? openLogFile,
    spawnServer: partial.spawnServer ?? defaultSpawnServer,
    say,
  };
}

function installedState(o: LaunchOptions): Installed {
  const inputs = o.staleInputs ?? defaultStaleInputs(o.projectRoot, { ...process.env, ...o.env });
  return {
    version: o.version,
    dataDir: o.dataDir,
    buildId: buildIdOf(o.distDir),
    frontendStale: frontendStatus(o.distDir, inputs).status !== 'fresh',
    serverCodeMtimeMs: newestMtime(o.serverInputs),
  };
}

async function healthOf(port: number, timeoutMs: number): Promise<Health | null> {
  const p = await probePort(port, timeoutMs);
  return p.kind === 'recall' ? p.health : null;
}

/**
 * Asks a Recall server to shut down; if it does not, terminates its pid. Never kills this process.
 * Resolves true once the port is free.
 */
export async function shutdownServer(port: number, pid: number | null, say: (l: string) => void = () => {}): Promise<boolean> {
  await postJson(port, '/api/system/shutdown');
  const gone = async () => (!pid || pid === process.pid || !isPidAlive(pid)) && (await isPortFree(port));
  if (await waitFor(gone, 10_000, 100)) return true;
  if (pid && pid !== process.pid && isPidAlive(pid)) {
    say(`Recall (pid ${pid}) did not stop when asked; terminating it.`);
    killPid(pid, 'SIGTERM');
    if (await waitFor(gone, 5_000, 100)) return true;
    killPid(pid, 'SIGKILL');
  }
  return waitFor(gone, 3_000, 100);
}

/** Recall versions from before server.json and /api/system/shutdown: find the listener by port and stop it. */
async function stopLegacy(port: number, say: (l: string) => void): Promise<boolean> {
  const pid = pidListeningOn(port);
  if (!pid || pid === process.pid || isRecallProcess(pid) !== true) return false;
  say(`Stopping an older Recall server (pid ${pid}) on port ${port}.`);
  return shutdownServer(port, pid, say);
}

/** Starts Recall, or reuses/replaces a running instance. Holds the launch lock so launches never race. */
export async function launch(partial: Partial<LaunchOptions> = {}): Promise<LaunchResult> {
  const o = resolveOptions(partial);
  fs.mkdirSync(o.dataDir, { recursive: true });
  let lock;
  try {
    lock = await acquireLock(path.join(o.dataDir, 'launch.lock'), { timeoutMs: o.lockTimeoutMs, staleMs: o.lockStaleMs });
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      return { action: 'failed', reason: 'Another Recall launch is still in progress. Wait a moment, then open Recall again.' };
    }
    throw e;
  }
  let result: LaunchResult | Crash;
  try {
    result = await launchLocked(o);
  } finally {
    lock.release();
  }
  if ('crash' in result) {
    o.say(`Recall could not start: ${result.crash.summary}`);
    let fallback: FallbackPage | undefined;
    if (o.detachErrorPage) await detachErrorPage(o, result.port, result.crash);
    else fallback = await serveFallback(o, result.port, result.crash);
    if (o.openBrowser) o.open(urlFor(result.port));
    return { action: 'failed', reason: result.crash.summary, port: result.port, fallback, errorPage: true };
  }
  if (result.action === 'failed') o.say(result.reason);
  return result;
}

interface Failure {
  summary: string;
  hint: string;
  log: string[];
}
interface Crash {
  crash: Failure;
  port: number;
}

async function launchLocked(o: LaunchOptions): Promise<LaunchResult | Crash> {
  const installed = installedState(o);
  const info = readServerInfo(o.dataDir);
  const ports = [...new Set([info?.port, o.port].filter((p): p is number => typeof p === 'number'))];
  const candidates: Candidate[] = [];

  for (const port of ports) {
    let probe = await probePort(port, o.healthTimeoutMs);
    // A recorded server that accepts connections but does not answer is hung: end it.
    if (probe.kind === 'unresponsive' && info?.port === port && isPidAlive(info.pid) && isRecallProcess(info.pid) !== false) {
      o.say(`Recall on port ${port} (pid ${info.pid}) is not responding; restarting it.`);
      await shutdownServer(port, info.pid, o.say);
      probe = await probePort(port, o.healthTimeoutMs);
    }
    if (probe.kind === 'legacy-recall' && (await stopLegacy(port, o.say))) probe = await probePort(port, o.healthTimeoutMs);
    const c: Candidate = { port, probe };
    if (probe.kind === 'recall' && isOurs(probe.health, installed)) {
      const a = assessHealth(probe.health, installed);
      if (a.action === 'verify-assets') {
        const v = await verifyFrontend(port, installed.buildId);
        c.assessment = v.ok ? { action: 'reuse', reason: 'Recall is already running and up to date' } : { action: 'restart', reason: `the app files are not served correctly (${v.reason})` };
      } else c.assessment = a;
    }
    if (probe.kind === 'recall' && probe.health.dev && sameDir(probe.health.dataDir, o.dataDir)) {
      return { action: 'failed', reason: `A Recall development server (npm run dev) is using this data folder on port ${port}. Stop it first.` };
    }
    candidates.push(c);
  }

  const reusable = candidates.some((c) => c.assessment);
  const configured = candidates.find((c) => c.port === o.port);
  const needFallback = !reusable && configured !== undefined && configured.probe.kind !== 'free';
  const freeFallback = needFallback ? await pickPort(o.fallbackPorts.filter((p) => p !== o.port)) : null;
  const decision = decide(candidates, o.port, installed, freeFallback);

  switch (decision.action) {
    case 'reuse': {
      o.say(`Opening the running Recall on port ${decision.port}: ${decision.reason}.`);
      if (decision.retry) await postJson(decision.port, '/api/startup/retry');
      if (o.openBrowser) o.open(urlFor(decision.port));
      return { action: 'reused', port: decision.port, url: urlFor(decision.port), reason: decision.reason };
    }
    case 'restart': {
      o.say(`Restarting Recall on port ${decision.port}: ${decision.reason}.`);
      if (!(await shutdownServer(decision.port, decision.pid, o.say))) {
        return { action: 'failed', reason: `The running Recall (pid ${decision.pid}) could not be stopped. Restart your computer or end it in Activity Monitor, then open Recall again.` };
      }
      removeServerInfo(o.dataDir, decision.pid);
      return start(o, decision.port);
    }
    case 'start':
      if (decision.port !== o.port) o.say(`Port ${o.port} is in use: ${decision.reason}.`);
      return start(o, decision.port);
    case 'fail':
      return { action: 'failed', reason: `${decision.reason} Close the program using port ${o.port}, or start Recall with --port <number>.` };
  }
}

/** Hints for the most common reasons a server dies before it listens. */
export function explainCrash(lines: string[], dataDir: string): Pick<Failure, 'summary' | 'hint'> {
  const text = lines.join('\n');
  const errorLine =
    [...lines].reverse().find((l) => /^\s*(\w*Error|\w*Exception)\b.*:/.test(l) && !/^\s+at\s/.test(l)) ??
    [...lines].reverse().find((l) => /error|failed|cannot/i.test(l) && !/^\s+at\s/.test(l)) ??
    lines.at(-1) ??
    'Recall stopped before it could open.';
  const summary = errorLine.trim().slice(0, 300);
  const snapshot = path.join(dataDir, 'backups');
  let hint = `Your data folder (${dataDir}) has not been changed. Fix the problem described in the technical details, then choose Retry.`;
  if (/NODE_MODULE_VERSION|bindings file|better_sqlite3\.node|was compiled against a different Node/i.test(text)) {
    hint = "Recall's database module was built for a different Node.js version. Open a terminal in the Recall folder, run npm rebuild better-sqlite3, then choose Retry.";
  } else if (/ERR_UNKNOWN_FILE_EXTENSION|Unknown file extension "\.ts"/.test(text)) {
    hint = 'This Node.js version is too old for Recall. Install Node.js 24 (for example: brew install node@24), then open Recall again.';
  } else if (/SQLITE_CORRUPT|SQLITE_NOTADB|malformed|file is not a database/i.test(text)) {
    hint = `The database file looks damaged. Your automatic snapshots are in ${snapshot}. With Recall stopped, copy the newest snapshot over recall.sqlite in the data folder, then choose Retry.`;
  } else if (/ERR_MODULE_NOT_FOUND|Cannot find (package|module)/.test(text)) {
    hint = "Some of Recall's files are missing. Open a terminal in the Recall folder, run npm ci, then choose Retry.";
  } else if (/EADDRINUSE/.test(text)) {
    hint = 'Another program took the port just as Recall was starting. Choose Retry.';
  } else if (/migration/i.test(text)) {
    hint = `Recall could not update its database. A snapshot was taken before the update; snapshots are in ${snapshot}. Choose Copy details and keep them with the log.`;
  }
  return { summary, hint };
}

async function start(o: LaunchOptions, port: number): Promise<LaunchResult | Crash> {
  if (!(await isPortFree(port))) return { action: 'failed', reason: `Port ${port} was taken by another program just now. Open Recall again.` };
  const offset = fileSize(o.logPath);
  o.say(`Starting Recall on port ${port} (data folder ${o.dataDir}).`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...o.env,
    RECALL_DIST_DIR: o.distDir,
    RECALL_LOG_FILE: o.logPath,
    RECALL_NO_OPEN: '1',
  };
  if (o.staleInputs) env.RECALL_STALE_INPUTS = o.staleInputs.join(path.delimiter);
  delete env.RECALL_DEV;
  let exited: string | null = null;
  let child: ChildProcess;
  try {
    child = o.spawnServer({ port, dataDir: o.dataDir, logPath: o.logPath, projectRoot: o.projectRoot, env });
  } catch (e) {
    return { crash: { summary: `Recall could not be started: ${(e as Error).message}`, hint: 'Choose Retry. If this keeps happening, copy the details.', log: [] }, port };
  }
  child.on('exit', (code, signal) => {
    exited = signal ? `signal ${signal}` : `exit code ${code}`;
  });
  child.on('error', (e) => {
    exited = e.message;
  });
  let health: Health | null = null;
  await waitFor(
    async () => {
      if (exited) return true;
      const h = await healthOf(port, 1000);
      if (h && sameDir(h.dataDir, o.dataDir) && !h.launcher) health = h;
      return health !== null;
    },
    o.startTimeoutMs,
    150,
  );
  if (!health) {
    if (!exited) child.kill('SIGKILL');
    const log = readTail(o.logPath, offset, 40).filter((l) => !l.startsWith('[launcher '));
    const why = exited
      ? explainCrash(log.length ? log : [`Recall stopped (${exited}).`], o.dataDir)
      : { summary: `Recall did not answer within ${Math.round(o.startTimeoutMs / 1000)} seconds.`, hint: 'Your computer may be very busy. Choose Retry, or open the log to see how far Recall got.' };
    return { crash: { ...why, log }, port };
  }
  child.unref();
  o.say(`Recall is listening on port ${port} (pid ${(health as Health).pid}).`);
  if (o.openBrowser) o.open(urlFor(port));
  return { action: 'started', port, url: urlFor(port), reason: 'started a new server' };
}

// ----- The launcher's own error page (when the server could not even start listening) -----

export interface FallbackPage {
  port: number;
  /** Resolves when the page is no longer needed: 'recovered' after a successful retry, 'idle' or 'stopped'. */
  done: Promise<'recovered' | 'idle' | 'stopped'>;
  close: () => Promise<void>;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function serveFallback(o: LaunchOptions, port: number, failure: Failure): Promise<FallbackPage> {
  const startedAt = new Date();
  let state: 'failed' | 'starting' = 'failed';
  const status = (): StartupStatus => ({
    app: 'recall',
    state,
    stage: state === 'failed' ? 'Recall could not start' : 'Starting Recall',
    message: state === 'failed' ? 'Recall stopped before it could open.' : 'Trying again…',
    startedAt: startedAt.toISOString(),
    elapsedMs: 0,
    error: state === 'failed' ? { summary: failure.summary, hint: failure.hint } : null,
    buildLog: failure.log,
    canUsePrevious: false,
    usingPrevious: false,
    logPath: o.logPath,
    report: formatReport({
      version: o.version,
      dataDir: o.dataDir,
      port,
      logPath: o.logPath,
      state,
      stage: 'Recall could not start',
      error: failure,
      buildLog: failure.log,
      buildId: buildIdOf(o.distDir),
    }),
    launcher: true,
  });
  const hosts = new Set(['127.0.0.1', 'localhost', '[::1]'].map((h) => `${h}:${port}`));
  const origins = new Set(['127.0.0.1', 'localhost', '[::1]'].map((h) => `http://${h}:${port}`));

  let resolveDone: (v: 'recovered' | 'idle' | 'stopped') => void = () => {};
  const done = new Promise<'recovered' | 'idle' | 'stopped'>((r) => (resolveDone = r));
  let idle: NodeJS.Timeout;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => void finish('idle'), o.fallbackIdleMs);
    idle.unref?.();
  };

  const send = (res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'",
      ...headers,
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = (req.url ?? '/').split('?')[0];
    if (!hosts.has((req.headers.host ?? '').toLowerCase())) {
      return send(res, 421, { error: { code: 'bad_host', message: 'Recall only answers requests addressed to its own loopback address' } });
    }
    if (MUTATING.has(method)) {
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      if ((origin !== undefined && !origins.has(origin)) || (typeof site === 'string' && site !== 'same-origin' && site !== 'none')) {
        return send(res, 403, { error: { code: 'bad_origin', message: 'Cross-origin requests are not allowed' } });
      }
      if (req.headers['x-recall-client'] !== '1') return send(res, 403, { error: { code: 'missing_client_header', message: 'Missing X-Recall-Client header' } });
    }
    req.resume();
    if (!(method === 'GET' && url === '/api/startup')) touch();
    if (method === 'GET' && url === '/api/health') {
      const h: Health = { ok: false, app: 'recall', version: o.version, pid: process.pid, dataDir: o.dataDir, port, buildId: buildIdOf(o.distDir), state, startedAt: startedAt.toISOString(), launcher: true };
      return send(res, 200, h);
    }
    if (method === 'GET' && url === '/api/startup') return send(res, 200, status());
    if (method === 'POST' && url === '/api/startup/open-log') {
      o.openLog(o.logPath);
      return send(res, 200, { ok: true, logPath: o.logPath });
    }
    if (method === 'POST' && url === '/api/startup/retry') {
      state = 'starting';
      send(res, 200, status());
      void retry();
      return;
    }
    if (method === 'POST' && url === '/api/system/shutdown') {
      send(res, 200, { ok: true, pid: process.pid });
      void finish('stopped');
      return;
    }
    if ((method === 'GET' || method === 'HEAD') && !url.startsWith('/api/')) {
      const nonce = newNonce();
      return send(res, 503, renderStatusPage(status(), nonce), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': statusPageCsp(nonce) });
    }
    send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
  });

  let finished = false;
  async function close() {
    clearTimeout(idle);
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  }
  async function finish(why: 'recovered' | 'idle' | 'stopped') {
    if (finished) return;
    finished = true;
    await close();
    o.say(why === 'idle' ? 'Closing the startup error page after 10 minutes without activity.' : `Startup error page closed (${why}).`);
    resolveDone(why);
  }
  async function retry() {
    if (finished) return;
    finished = true;
    await new Promise((r) => setTimeout(r, 50)); // let the reply reach the browser
    await close();
    o.say('Retrying the launch from the error page.');
    const r = await launch({ ...o, openBrowser: false });
    if (r.action === 'failed' && r.fallback) void r.fallback.done.then(resolveDone);
    else if (r.action === 'failed') {
      o.say(`Retry failed: ${r.reason}`);
      resolveDone('stopped');
    } else resolveDone('recovered');
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      touch();
      o.say(`Showing the startup error page at ${urlFor(port)}`);
      resolve({ port, done, close: () => finish('stopped') });
    });
  });
}

// ----- Stop -----

/** Stops the Recall server for this data folder: graceful shutdown via the API, then its pid. */
export async function stop(partial: Partial<LaunchOptions> = {}): Promise<StopResult> {
  const o = resolveOptions(partial);
  const info = readServerInfo(o.dataDir);
  const ports = [...new Set([info?.port, o.port].filter((p): p is number => typeof p === 'number'))];
  for (const port of ports) {
    const probe = await probePort(port, o.healthTimeoutMs);
    if (probe.kind === 'recall' && sameDir(probe.health.dataDir, o.dataDir)) {
      const ok = await shutdownServer(port, probe.health.pid, o.say);
      if (ok) removeServerInfo(o.dataDir);
      const message = ok ? 'Recall stopped.' : `Recall (pid ${probe.health.pid}) could not be stopped.`;
      o.say(message);
      return { ok, stopped: ok, message };
    }
    if (probe.kind === 'legacy-recall' && port === o.port && (await stopLegacy(port, o.say))) {
      removeServerInfo(o.dataDir);
      return { ok: true, stopped: true, message: 'Recall stopped.' };
    }
  }
  if (info && info.pid !== process.pid && isPidAlive(info.pid) && isRecallProcess(info.pid) !== false) {
    o.say(`Recall (pid ${info.pid}) did not answer; terminating it.`);
    killPid(info.pid, 'SIGTERM');
    let ok = await waitFor(() => !isPidAlive(info.pid), 5_000);
    if (!ok) {
      killPid(info.pid, 'SIGKILL');
      ok = await waitFor(() => !isPidAlive(info.pid), 2_000);
    }
    if (ok) removeServerInfo(o.dataDir);
    return { ok, stopped: ok, message: ok ? 'Recall stopped.' : `Recall (pid ${info.pid}) could not be stopped.` };
  }
  removeServerInfo(o.dataDir);
  return { ok: true, stopped: false, message: 'Recall was not running.' };
}

// ----- CLI -----

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const pref = argv.find((a) => a.startsWith(`${name}=`));
  return pref ? pref.slice(name.length + 1) : undefined;
}

export function parseArgs(argv: string[]): Partial<LaunchOptions> & { stop: boolean; serveError?: string } {
  const port = argValue(argv, '--port');
  const out: Partial<LaunchOptions> & { stop: boolean; serveError?: string } = { stop: argv.includes('--stop') };
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid port: ${port}`);
    out.port = n;
  }
  const dataDir = argValue(argv, '--data-dir');
  if (dataDir) out.dataDir = dataDir;
  if (argv.includes('--no-open')) out.openBrowser = false;
  const serveError = argValue(argv, '--serve-error');
  if (serveError) out.serveError = serveError;
  return out;
}

/** Message for the macOS wrapper's dialog or notification (RECALL_MESSAGE_FILE). */
function report(message: string) {
  const file = process.env.RECALL_MESSAGE_FILE;
  if (file) {
    try {
      fs.writeFileSync(file, message);
    } catch {
      /* best-effort */
    }
  }
  console.log(message);
}

interface ErrorPageJob {
  options: Partial<LaunchOptions>;
  port: number;
  failure: Failure;
}

/** Starts the error page in its own detached process and waits until it answers. */
async function detachErrorPage(o: LaunchOptions, port: number, failure: Failure): Promise<void> {
  const job: ErrorPageJob = {
    options: { dataDir: o.dataDir, port: o.port, fallbackPorts: o.fallbackPorts, distDir: o.distDir, logPath: o.logPath, env: o.env, staleInputs: o.staleInputs },
    port,
    failure,
  };
  const file = path.join(o.dataDir, 'launch-error.json');
  fs.writeFileSync(file, JSON.stringify(job));
  const fd = fs.openSync(o.logPath, 'a');
  try {
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve-error', file], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: process.env }).unref();
  } finally {
    fs.closeSync(fd);
  }
  await waitFor(async () => (await healthOf(port, 500))?.launcher === true, 5_000, 100);
}

async function serveErrorJob(file: string): Promise<number> {
  const job = JSON.parse(fs.readFileSync(file, 'utf8')) as ErrorPageJob;
  fs.rmSync(file, { force: true });
  const page = await serveFallback(resolveOptions({ ...job.options, openBrowser: false }), job.port, job.failure);
  await page.done;
  return 0;
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    report((e as Error).message);
    return 2;
  }
  if (args.serveError) return serveErrorJob(args.serveError);
  const partial: Partial<LaunchOptions> = { port: args.port, dataDir: args.dataDir, openBrowser: args.openBrowser };
  if (args.stop) {
    const r = await stop(partial);
    report(r.message);
    return r.ok ? 0 : 1;
  }
  const r = await launch({ ...partial, detachErrorPage: true });
  if (r.action !== 'failed') {
    report(r.action === 'reused' ? `Opened the running Recall at ${r.url} (${r.reason}).` : `Recall started at ${r.url}`);
    return 0;
  }
  // With an error page the browser shows the explanation, so the wrapper needs no dialog.
  report(`Recall could not start. ${r.reason}`);
  return r.errorPage ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      report(`Recall could not start: ${(e as Error).message}`);
      console.error(e);
      process.exit(1);
    },
  );
}
