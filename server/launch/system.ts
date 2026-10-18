import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls `check` until it returns true or the timeout elapses. */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= end) return false;
    await sleep(intervalMs);
  }
}

export function isPidAlive(pid: number | undefined | null): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Best-effort check that `pid` is a Recall server (guards against pid reuse before killing).
 * Returns null when the platform cannot tell.
 */
export function isRecallProcess(pid: number): boolean | null {
  if (process.platform === 'win32') return null;
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    return /server[\\/]index\.ts/.test(cmd);
  } catch {
    return false;
  }
}

/** The pid listening on a local TCP port (macOS/Linux with lsof), or null. */
export function pidListeningOn(port: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 2000 });
    const pid = Number(out.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function killPid(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Opens a file or URL with the operating system's default application. Best-effort. */
export function openWithOs(target: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* opening is best-effort */
  }
}

/** Opens the log file, creating it first so the OS has something to show. */
export function openLogFile(file: string): void {
  try {
    fs.closeSync(fs.openSync(file, 'a'));
  } catch {
    /* the folder may be missing; openWithOs will fail quietly */
  }
  openWithOs(file);
}

export function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Last `maxLines` non-empty lines of a file, read from byte `fromOffset` (bounded to the last 64 KB). */
export function readTail(file: string, fromOffset = 0, maxLines = 40): string[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(fromOffset, size - 64 * 1024, 0);
    const buf = Buffer.alloc(Math.max(0, size - start));
    fs.readSync(fd, buf, 0, buf.length, start);
    return stripAnsi(buf.toString('utf8'))
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}
