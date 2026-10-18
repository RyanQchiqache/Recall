import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_VERSION = '1.0.0';
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface AppConfig {
  dataDir: string;
  dbPath: string;
  mediaDir: string;
  tmpDir: string;
  defaultBackupDir: string;
  host: string;
  port: number;
  dev: boolean;
  /** Built frontend (served in production mode). */
  distDir: string;
  /** Extra origins allowed to send mutations (e.g. the Vite dev server). */
  extraOrigins: string[];
  /** Log file shown by the startup page's "Open log". */
  logPath?: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Platform default data directory. Kept outside the source tree and build outputs. */
export function defaultDataDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Recall');
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Recall');
    default:
      return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'recall');
  }
}

/** Default log file: ~/Library/Logs/Recall.log on macOS (where Console.app looks), recall.log in the data dir elsewhere. */
export function defaultLogPath(dataDir: string): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Logs', 'Recall.log');
  return path.join(path.resolve(dataDir), 'recall.log');
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const pref = argv.find((a) => a.startsWith(`${name}=`));
  return pref ? pref.slice(name.length + 1) : undefined;
}

export function pathsFor(dataDir: string) {
  const abs = path.resolve(dataDir);
  return {
    dataDir: abs,
    dbPath: path.join(abs, 'recall.sqlite'),
    mediaDir: path.join(abs, 'media'),
    tmpDir: path.join(abs, 'tmp'),
    defaultBackupDir: path.join(abs, 'backups'),
  };
}

export function loadConfig(argv: string[] = process.argv.slice(2), env = process.env): AppConfig {
  const dataDir = argValue(argv, '--data-dir') ?? env.RECALL_DATA_DIR ?? defaultDataDir();
  const host = argValue(argv, '--host') ?? env.RECALL_HOST ?? '127.0.0.1';
  if (!LOOPBACK.has(host)) {
    throw new Error(
      `Refusing to bind to "${host}". Recall is a single-user loopback app and only binds to 127.0.0.1, ::1 or localhost.`,
    );
  }
  const port = Number(argValue(argv, '--port') ?? env.RECALL_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  const dev = argv.includes('--dev') || env.RECALL_DEV === '1';
  return {
    ...pathsFor(dataDir),
    host,
    port,
    dev,
    distDir: path.resolve(argValue(argv, '--dist-dir') ?? env.RECALL_DIST_DIR ?? path.join(PROJECT_ROOT, 'dist')),
    extraOrigins: dev ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : [],
    logPath: path.resolve(argValue(argv, '--log-file') ?? env.RECALL_LOG_FILE ?? defaultLogPath(dataDir)),
  };
}
