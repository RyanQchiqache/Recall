import path from 'node:path';
import type { Health, Probe } from './probe.ts';

/** What the launcher knows about the installed (on-disk) version of Recall. */
export interface Installed {
  version: string;
  dataDir: string;
  /** Hash of the current dist/index.html, or null if there is no build. */
  buildId: string | null;
  /** True if frontend sources are newer than dist/index.html (or dist is missing). */
  frontendStale: boolean;
  /** Last modification time of server code, to detect a server started before an update. */
  serverCodeMtimeMs: number;
}

export type Assessment =
  | { action: 'reuse'; reason: string; retry?: boolean }
  | { action: 'restart'; reason: string }
  | { action: 'verify-assets' };

export function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** Is this Recall server one we may reuse or restart, i.e. a production server for our data dir? */
export function isOurs(health: Health, installed: Installed): boolean {
  return !health.dev && sameDir(health.dataDir, installed.dataDir);
}

/**
 * Decides from the health answer alone whether a running Recall server for our data dir can be reused.
 * A server that is still starting or rebuilding is reused (its status page explains the wait);
 * a failed one is reused and asked to retry. A ready one must match the installed build exactly,
 * and then still has to pass the asset check.
 */
export function assessHealth(health: Health, installed: Installed): Assessment {
  if (health.version !== installed.version) return { action: 'restart', reason: `Recall was updated (running ${health.version}, installed ${installed.version})` };
  const started = Date.parse(health.startedAt);
  if (Number.isFinite(started) && installed.serverCodeMtimeMs > started) return { action: 'restart', reason: 'the server code changed after this server started' };
  if (health.launcher) return { action: 'reuse', reason: 'the launcher is showing a startup error', retry: true };
  if (health.state === 'starting' || health.state === 'building') return { action: 'reuse', reason: `the server is ${health.state === 'building' ? 'rebuilding' : 'starting'}` };
  if (health.state === 'failed') return { action: 'reuse', reason: 'the last startup failed', retry: true };
  if (health.buildId !== installed.buildId) return { action: 'restart', reason: 'the server is serving a different build than the one on disk' };
  if (installed.frontendStale) return { action: 'restart', reason: 'the app was updated since the last build' };
  return { action: 'verify-assets' };
}

export type Decision =
  | { action: 'reuse'; port: number; reason: string; retry?: boolean }
  | { action: 'restart'; port: number; pid: number; reason: string }
  | { action: 'start'; port: number; reason: string }
  | { action: 'fail'; reason: string };

export interface Candidate {
  port: number;
  probe: Probe;
  /** Result of assessHealth plus the asset check, for Recall servers that are ours. */
  assessment?: { action: 'reuse'; reason: string; retry?: boolean } | { action: 'restart'; reason: string };
}

/**
 * Chooses between reusing a running server, restarting a stale one, or starting a new one.
 * `candidates` are the ports from server.json and the configured port, in that order;
 * `freePort` is the first free fallback port (if the configured port is taken by something else).
 */
export function decide(candidates: Candidate[], configuredPort: number, installed: Installed, freeFallback: number | null): Decision {
  for (const c of candidates) {
    if (c.probe.kind !== 'recall' || !isOurs(c.probe.health, installed) || !c.assessment) continue;
    if (c.assessment.action === 'reuse') return { action: 'reuse', port: c.port, reason: c.assessment.reason, retry: c.assessment.retry };
    return { action: 'restart', port: c.port, pid: c.probe.health.pid, reason: c.assessment.reason };
  }
  const configured = candidates.find((c) => c.port === configuredPort);
  if (!configured || configured.probe.kind === 'free') return { action: 'start', port: configuredPort, reason: 'no Recall server is running' };
  if (freeFallback !== null) {
    return { action: 'start', port: freeFallback, reason: `port ${configuredPort} is used by another program (${describe(configured.probe)}), so Recall uses port ${freeFallback}` };
  }
  return { action: 'fail', reason: `Port ${configuredPort} and the fallback ports are all in use by other programs.` };
}

function describe(p: Probe): string {
  switch (p.kind) {
    case 'recall':
      return p.health.dev ? 'a Recall development server' : `Recall for ${p.health.dataDir}`;
    case 'legacy-recall':
      return `an older Recall ${p.version}`;
    case 'foreign':
      return p.detail;
    case 'unresponsive':
      return 'not answering';
    default:
      return 'free';
  }
}
