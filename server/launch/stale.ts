import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Files and folders whose changes require a new frontend build. */
export function defaultStaleInputs(projectRoot: string): string[] {
  return ['src', 'shared', 'public', 'index.html', 'package.json', 'vite.config.ts'].map((p) => path.join(projectRoot, p));
}

/** Staleness inputs, overridable with RECALL_STALE_INPUTS (a path-delimiter separated list) for tests. */
export function staleInputs(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.RECALL_STALE_INPUTS;
  if (override) return override.split(path.delimiter).filter(Boolean).map((p) => path.resolve(projectRoot, p));
  return defaultStaleInputs(projectRoot);
}

/**
 * Returns the first input (file or directory) modified after `refMs`, or null.
 * Walks directories depth-first and stops at the first hit, so a stale tree is detected quickly
 * and a fresh one costs one stat per entry. Directory mtimes are included so deleted files count too.
 */
export function findNewerThan(inputs: string[], refMs: number): string | null {
  const stack = [...inputs];
  while (stack.length > 0) {
    const p = stack.pop() as string;
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.mtimeMs > refMs) return p;
    if (!st.isDirectory()) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      stack.push(path.join(p, e.name));
    }
  }
  return null;
}

/** Newest modification time among the inputs (recursively), or 0. */
export function newestMtime(inputs: string[]): number {
  let newest = 0;
  const stack = [...inputs];
  while (stack.length > 0) {
    const p = stack.pop() as string;
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    newest = Math.max(newest, st.mtimeMs);
    if (!st.isDirectory()) continue;
    try {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules') stack.push(path.join(p, e.name));
      }
    } catch {
      /* unreadable folder */
    }
  }
  return newest;
}

export type FrontendStatus = { status: 'missing' } | { status: 'stale'; newer: string } | { status: 'fresh' };

/** Decides whether dist/ is missing, older than any staleness input, or up to date. */
export function frontendStatus(distDir: string, inputs: string[]): FrontendStatus {
  let ref: number;
  try {
    ref = fs.statSync(path.join(distDir, 'index.html')).mtimeMs;
  } catch {
    return { status: 'missing' };
  }
  const newer = findNewerThan(inputs, ref);
  return newer ? { status: 'stale', newer } : { status: 'fresh' };
}

export function hashBuild(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/** Short content hash of dist/index.html, which changes with every build (it names the hashed assets). */
export function buildIdOf(distDir: string): string | null {
  try {
    return hashBuild(fs.readFileSync(path.join(distDir, 'index.html')));
  } catch {
    return null;
  }
}
