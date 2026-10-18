import fs from 'node:fs';
import path from 'node:path';

/** Written to <dataDir>/server.json by a listening server so launchers can find it. */
export interface ServerInfo {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
  dataDir?: string;
}

export function serverInfoPath(dataDir: string): string {
  return path.join(dataDir, 'server.json');
}

export function readServerInfo(dataDir: string): ServerInfo | null {
  try {
    const v = JSON.parse(fs.readFileSync(serverInfoPath(dataDir), 'utf8')) as Partial<ServerInfo>;
    if (typeof v.pid !== 'number' || typeof v.port !== 'number') return null;
    return { pid: v.pid, port: v.port, startedAt: String(v.startedAt ?? ''), version: String(v.version ?? ''), dataDir: v.dataDir };
  } catch {
    return null;
  }
}

export function writeServerInfo(dataDir: string, info: ServerInfo): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = serverInfoPath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2));
  fs.renameSync(tmp, file);
}

/** Removes server.json, but only if it still describes `pid` (when given). */
export function removeServerInfo(dataDir: string, pid?: number): void {
  if (pid !== undefined) {
    const cur = readServerInfo(dataDir);
    if (cur && cur.pid !== pid) return;
  }
  fs.rmSync(serverInfoPath(dataDir), { force: true });
}
