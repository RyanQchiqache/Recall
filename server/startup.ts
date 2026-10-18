import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Health, StartupState } from './launch/probe.ts';
import { buildIdOf, frontendStatus, staleInputs } from './launch/stale.ts';
import { formatReport, newNonce, renderStatusPage, statusPageCsp, type StartupStatus } from './launch/statusPage.ts';
import { openLogFile, stripAnsi } from './launch/system.ts';

export { renderStatusPage, statusPageCsp, newNonce, formatReport };
export type { StartupState, StartupStatus };

const LOG_TAIL = 40;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

export interface StartupOptions {
  projectRoot: string;
  distDir: string;
  dataDir: string;
  port: number;
  version: string;
  logPath: string;
  /** Development mode never builds; Vite serves the frontend. */
  dev?: boolean;
  /** Paths whose changes make dist stale. Defaults to src, shared, public, index.html, package.json, vite.config.ts. */
  inputs?: string[];
  /** Overrides the build: a shell command string or an argv array. Defaults to RECALL_BUILD_COMMAND, then Vite. */
  buildCommand?: string | string[];
  env?: NodeJS.ProcessEnv;
  /** Receives build output lines (the server prints them, so they land in the log). */
  log?: (line: string) => void;
  buildTimeoutMs?: number;
  now?: () => number;
}

interface BuildCommand {
  cmd: string;
  args: string[];
  shell: boolean;
}

export class BuildError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

/** Resolves the build command without relying on the shell's PATH: this Node binary plus Vite's own entry script. */
export function resolveBuildCommand(projectRoot: string, outDir: string, override?: string | string[]): BuildCommand {
  if (Array.isArray(override)) return { cmd: override[0], args: override.slice(1), shell: false };
  if (override) {
    if (override.trim().startsWith('[')) {
      const argv = JSON.parse(override) as string[];
      return { cmd: argv[0], args: argv.slice(1), shell: false };
    }
    return { cmd: override, args: [], shell: true };
  }
  const vite = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(vite)) {
    throw new BuildError(
      "Recall's build tools are not installed (node_modules/vite is missing).",
      'Open a terminal in the Recall folder and run: npm ci',
    );
  }
  return { cmd: process.execPath, args: [vite, 'build', '--outDir', outDir, '--emptyOutDir'], shell: false };
}

/** Renames with a few retries (Windows briefly locks files that are being served). */
function renameRetry(from: string, to: string) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (i + 1));
    }
  }
}

/**
 * Replaces dist with dist-next: dist → dist-old, dist-next → dist, delete dist-old.
 * If the second rename fails, the old build is put back, so a working dist is never lost.
 */
export function swapDist(distDir: string, nextDir: string): void {
  const oldDir = `${distDir}-old`;
  fs.rmSync(oldDir, { recursive: true, force: true });
  const hadDist = fs.existsSync(distDir);
  if (hadDist) renameRetry(distDir, oldDir);
  try {
    renameRetry(nextDir, distDir);
  } catch (e) {
    if (hadDist && !fs.existsSync(distDir)) renameRetry(oldDir, distDir);
    throw e;
  }
  fs.rmSync(oldDir, { recursive: true, force: true });
}

/** Picks the most useful single line from build output for the error summary. */
export function summarizeBuildOutput(lines: string[], code: number | null, signal: string | null): string {
  const clean = lines.map((l) => l.trim()).filter(Boolean);
  const cut = (l: string) => (l.length > 300 ? `${l.slice(0, 297)}…` : l);
  const isHeader = (l: string) => /^error during build:?$/i.test(l);
  const explicit = clean.find((l) => !isHeader(l) && /\berror\b\s*:\s*\S/i.test(l));
  if (explicit) return cut(explicit);
  const header = clean.findIndex(isHeader);
  if (header >= 0 && clean[header + 1]) return cut(clean[header + 1]);
  const vague = clean.find((l) => !isHeader(l) && /error|failed/i.test(l));
  if (vague) return cut(vague);
  if (signal) return `The build was stopped (${signal}).`;
  const last = clean.at(-1);
  return last ? cut(last) : `The build exited with code ${code}.`;
}

/**
 * The startup state machine: starting → (building →) ready, or failed.
 * The HTTP server listens before this runs, so the status page can explain every stage.
 */
export class Startup {
  state: StartupState;
  stage: string;
  message: string;
  readonly startedAt: Date;
  stateSince: number;
  error: { summary: string; hint: string } | null = null;
  buildLog: string[] = [];
  buildId: string | null;
  usingPrevious = false;
  readonly opts: StartupOptions;
  private running: Promise<void> | null = null;
  private now: () => number;

  constructor(opts: StartupOptions, initial: 'starting' | 'ready' = 'starting') {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.startedAt = new Date(this.now());
    this.stateSince = this.now();
    this.state = initial;
    this.stage = initial === 'ready' ? 'Opening Recall' : 'Starting Recall';
    this.message = initial === 'ready' ? 'Recall is ready.' : 'This usually takes a few seconds.';
    this.buildId = buildIdOf(opts.distDir);
  }

  get ready(): boolean {
    return this.state === 'ready';
  }

  get hasPreviousBuild(): boolean {
    return fs.existsSync(path.join(this.opts.distDir, 'index.html'));
  }

  private set(state: StartupState, stage: string, message: string) {
    if (state !== this.state) this.stateSince = this.now();
    this.state = state;
    this.stage = stage;
    this.message = message;
  }

  /** Runs the startup sequence (once at a time). Resolves when it reaches ready or failed. */
  run(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.sequence().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Re-runs startup after a failure; a no-op while running or when already ready. */
  retry(): Promise<void> {
    if (this.state === 'failed') {
      this.error = null;
      this.set('starting', 'Starting Recall', 'Trying again…');
      return this.run();
    }
    return this.running ?? Promise.resolve();
  }

  /** After a failed rebuild, serve the previous build. */
  usePrevious(): boolean {
    if (this.state !== 'failed' || !this.hasPreviousBuild) return false;
    this.usingPrevious = true;
    this.buildId = buildIdOf(this.opts.distDir);
    this.set('ready', 'Opening Recall', 'Opening the previous version of Recall.');
    return true;
  }

  private async sequence(): Promise<void> {
    this.set('starting', 'Starting Recall', 'This usually takes a few seconds.');
    if (this.opts.dev) {
      this.set('ready', 'Opening Recall', 'Recall is ready.');
      return;
    }
    const env = this.opts.env ?? process.env;
    const inputs = this.opts.inputs ?? staleInputs(this.opts.projectRoot, env);
    const fe = frontendStatus(this.opts.distDir, inputs);
    if (fe.status === 'fresh') {
      this.buildId = buildIdOf(this.opts.distDir);
      this.usingPrevious = false;
      this.set('ready', 'Opening Recall', 'Recall is ready.');
      return;
    }
    this.log(fe.status === 'missing' ? 'Frontend build missing; building it now.' : `Frontend is out of date (${path.relative(this.opts.projectRoot, fe.newer) || fe.newer} changed); rebuilding.`);
    this.set(
      'building',
      fe.status === 'missing' ? 'Preparing Recall for its first start…' : 'Rebuilding after an update…',
      'Recall is preparing the current version of the app. This happens once after an update and usually takes less than a minute.',
    );
    this.buildLog = [];
    try {
      await this.build(env);
      this.buildId = buildIdOf(this.opts.distDir);
      this.usingPrevious = false;
      this.log(`Frontend rebuilt (build ${this.buildId}).`);
      this.set('ready', 'Opening Recall', 'Recall is ready.');
    } catch (e) {
      const err = e as BuildError;
      const previous = this.hasPreviousBuild;
      this.error = {
        summary: err.message,
        hint:
          err.hint ??
          (previous
            ? 'Your cards and data are safe. You can open the previous version of Recall, or fix the problem and choose Retry.'
            : 'Your cards and data are safe. Recall needs a successful build before it can open. Fix the problem and choose Retry, or copy the details for whoever looks after your Recall installation.'),
      };
      this.log(`Frontend build failed: ${err.message}`);
      this.set('failed', 'The update could not be built', 'Recall could not prepare the new version of the app.');
    }
  }

  private log(line: string) {
    (this.opts.log ?? ((l: string) => console.log(l)))(line);
  }

  private pushOutput(chunk: string, carry: { rest: string }) {
    const text = carry.rest + stripAnsi(chunk);
    const lines = text.split(/\r?\n/);
    carry.rest = lines.pop() ?? '';
    for (const l of lines) {
      if (!l.trim()) continue;
      this.buildLog.push(l);
      this.log(`[build] ${l}`);
    }
    if (this.buildLog.length > 400) this.buildLog = this.buildLog.slice(-LOG_TAIL * 2);
  }

  private build(env: NodeJS.ProcessEnv): Promise<void> {
    const { distDir, projectRoot } = this.opts;
    const nextDir = `${distDir}-next`;
    const command = resolveBuildCommand(projectRoot, nextDir, this.opts.buildCommand ?? env.RECALL_BUILD_COMMAND);
    fs.rmSync(nextDir, { recursive: true, force: true });
    const buildStartedMs = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(command.cmd, command.args, {
        cwd: projectRoot,
        shell: command.shell,
        env: { ...env, RECALL_BUILD_OUT_DIR: nextDir, NO_COLOR: '1', FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const out = { rest: '' };
      const errOut = { rest: '' };
      child.stdout.setEncoding('utf8').on('data', (c: string) => this.pushOutput(c, out));
      child.stderr.setEncoding('utf8').on('data', (c: string) => this.pushOutput(c, errOut));
      const timer = setTimeout(() => child.kill('SIGKILL'), this.opts.buildTimeoutMs ?? BUILD_TIMEOUT_MS);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new BuildError(`The build could not be started: ${e.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        this.pushOutput('\n', out);
        this.pushOutput('\n', errOut);
        if (code !== 0) {
          fs.rmSync(nextDir, { recursive: true, force: true });
          reject(new BuildError(summarizeBuildOutput(this.buildLog, code, signal)));
          return;
        }
        if (!fs.existsSync(path.join(nextDir, 'index.html'))) {
          fs.rmSync(nextDir, { recursive: true, force: true });
          reject(new BuildError('The build finished but produced no index.html.'));
          return;
        }
        try {
          // Date the build by when it started, so source edits made during the build still count as newer.
          const t = new Date(buildStartedMs);
          fs.utimesSync(path.join(nextDir, 'index.html'), t, t);
          swapDist(distDir, nextDir);
          resolve();
        } catch (e) {
          reject(new BuildError(`The new build could not be put in place: ${(e as Error).message}`));
        }
      });
    });
  }

  status(): StartupStatus {
    const buildLog = this.buildLog.slice(-LOG_TAIL);
    return {
      app: 'recall',
      state: this.state,
      stage: this.stage,
      message: this.message,
      startedAt: this.startedAt.toISOString(),
      elapsedMs: Math.max(0, this.now() - this.stateSince),
      error: this.error,
      buildLog,
      canUsePrevious: this.state === 'failed' && this.hasPreviousBuild,
      usingPrevious: this.usingPrevious,
      logPath: this.opts.logPath,
      report: formatReport({
        version: this.opts.version,
        dataDir: this.opts.dataDir,
        port: this.opts.port,
        logPath: this.opts.logPath,
        state: this.state,
        stage: this.stage,
        error: this.error,
        buildLog,
        buildId: this.buildId,
      }),
    };
  }

  health(): Health {
    return {
      ok: true,
      app: 'recall',
      version: this.opts.version,
      pid: process.pid,
      dataDir: this.opts.dataDir,
      port: this.opts.port,
      buildId: this.buildId,
      state: this.state,
      startedAt: this.startedAt.toISOString(),
      dev: this.opts.dev ? true : undefined,
    };
  }
}

/** App pages are everything a browser navigates to: not the API, media, built assets or other static files. */
export function isAppPage(url: string): boolean {
  const p = url.split('?')[0];
  if (p.startsWith('/api/') || p.startsWith('/media/') || p.startsWith('/assets/')) return false;
  const last = p.slice(p.lastIndexOf('/') + 1);
  return !last.includes('.') || last.endsWith('.html');
}

export function sendStatusPage(reply: FastifyReply, status: StartupStatus) {
  const nonce = newNonce();
  reply.code(503);
  reply.header('Content-Security-Policy', statusPageCsp(nonce));
  reply.header('Cache-Control', 'no-store');
  reply.header('Retry-After', '1');
  return reply.type('text/html; charset=utf-8').send(renderStatusPage(status, nonce));
}

export interface StartupRouteOptions {
  startup: Startup;
  /** Called after the shutdown response is sent. */
  onShutdown: () => void;
  openLog?: (file: string) => void;
}

/**
 * Health, startup status and system endpoints, plus the gate that shows the status page until startup is ready.
 * Registered after the Host/Origin/X-Recall-Client hook, so every POST here is protected the same way as the rest of the API.
 */
export function registerStartup(app: FastifyInstance, o: StartupRouteOptions) {
  const { startup } = o;
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (startup.ready || (req.method !== 'GET' && req.method !== 'HEAD') || !isAppPage(req.url)) return;
    sendStatusPage(reply, startup.status());
    return reply;
  });

  const noStore = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store');
  app.get('/api/health', async (_req, reply) => {
    noStore(reply);
    return startup.health();
  });
  app.get('/api/startup', async (_req, reply) => {
    noStore(reply);
    return startup.status();
  });
  app.post('/api/startup/retry', async (_req, reply) => {
    noStore(reply);
    void startup.retry();
    return startup.status();
  });
  app.post('/api/startup/use-previous', async (_req, reply) => {
    noStore(reply);
    if (!startup.usePrevious()) {
      reply.code(409);
      return { error: { code: 'no_previous_build', message: 'There is no previous version to open.' } };
    }
    return startup.status();
  });
  app.post('/api/startup/open-log', async () => {
    (o.openLog ?? openLogFile)(startup.opts.logPath);
    return { ok: true, logPath: startup.opts.logPath };
  });
  app.post(
    '/api/system/shutdown',
    {
      // Only after the reply has been sent, so the caller learns that the shutdown was accepted.
      onResponse: async (_req, reply) => {
        if (reply.statusCode === 200) setTimeout(o.onShutdown, 20);
      },
    },
    async () => ({ ok: true, pid: process.pid }),
  );
}
