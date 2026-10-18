import fs from 'node:fs';
import path from 'node:path';
import { isPidAlive, sleep } from './system.ts';

export interface LockOwner {
  pid: number;
  createdAt: number;
  token: string;
}

export interface LockOptions {
  /** How long to wait for another launch to finish. */
  timeoutMs?: number;
  /** A lock older than this is considered abandoned. */
  staleMs?: number;
  pollMs?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

export interface Lock {
  dir: string;
  owner: LockOwner;
  release: () => void;
}

export class LockTimeoutError extends Error {}

const OWNER_FILE = 'owner.json';

function readOwner(dir: string): LockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8')) as LockOwner;
  } catch {
    return null;
  }
}

/** Whether an existing lock may be broken: its owner is gone, or it is too old (or never got an owner file). */
export function isLockStale(dir: string, opts: Required<Pick<LockOptions, 'staleMs' | 'isAlive' | 'now'>>): boolean {
  const owner = readOwner(dir);
  let created = owner?.createdAt;
  if (created === undefined) {
    try {
      created = fs.statSync(dir).mtimeMs;
    } catch {
      return false; // vanished: not stale, simply retry mkdir
    }
  }
  if (opts.now() - created > opts.staleMs) return true;
  return owner !== null && !opts.isAlive(owner.pid);
}

/**
 * An atomic, cross-platform launch lock: mkdir either creates the directory or fails because it exists.
 * The owner (pid, time, random token) is written inside so a crashed launcher's lock can be broken safely.
 */
export async function acquireLock(dir: string, options: LockOptions = {}): Promise<Lock> {
  const timeoutMs = options.timeoutMs ?? 150_000;
  const staleMs = options.staleMs ?? 120_000;
  const pollMs = options.pollMs ?? 100;
  const isAlive = options.isAlive ?? isPidAlive;
  const now = options.now ?? Date.now;
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  for (;;) {
    try {
      fs.mkdirSync(dir);
      const owner: LockOwner = { pid: process.pid, createdAt: now(), token: Math.random().toString(36).slice(2) };
      fs.writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify(owner));
      return {
        dir,
        owner,
        release: () => {
          if (readOwner(dir)?.token === owner.token) fs.rmSync(dir, { recursive: true, force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (isLockStale(dir, { staleMs, isAlive, now })) {
      breakLock(dir);
      continue;
    }
    if (Date.now() >= deadline) throw new LockTimeoutError('Another Recall launch is still in progress.');
    await sleep(pollMs);
  }
}

/** Moves a stale lock aside atomically; if a fresh lock replaced it in the meantime, puts that one back. */
function breakLock(dir: string): void {
  const seen = readOwner(dir);
  const aside = `${dir}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(dir, aside);
  } catch {
    return; // someone else broke it first
  }
  const moved = readOwner(aside);
  if (seen && moved && moved.token !== seen.token) {
    try {
      fs.renameSync(aside, dir);
      return;
    } catch {
      /* fall through and discard */
    }
  }
  fs.rmSync(aside, { recursive: true, force: true });
}
