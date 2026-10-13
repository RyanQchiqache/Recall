import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.ts';
import { APP_VERSION, loadConfig } from './config.ts';
import { backupDir, runAutoBackup } from './services/backup.ts';

const BACKUP_CHECK_MS = 10 * 60 * 1000;

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* opening a browser is best-effort */
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let config;
  try {
    config = loadConfig(argv);
  } catch (e) {
    console.error(`\n  ${(e as Error).message}\n`);
    process.exit(1);
  }
  if (!config.dev && !fs.existsSync(path.join(config.distDir, 'index.html'))) {
    console.warn('\n  The frontend has not been built yet. Run `npm run build` first, then `npm start`.\n');
  }
  const { app, ctx, close } = await buildApp({ config });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${config.port} is already in use. Is Recall already running? Start with --port <number> to use another port.\n`);
    } else console.error(err);
    await close();
    process.exit(1);
  }
  const url = `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`;
  console.log(`\n  Recall ${APP_VERSION} ${config.dev ? '(API, development mode)' : ''}`);
  console.log(`  App:        ${config.dev ? 'http://127.0.0.1:5173 (Vite)' : url}`);
  console.log(`  Data dir:   ${config.dataDir}`);
  console.log(`  Database:   ${config.dbPath}`);
  console.log(`  Snapshots:  ${backupDir(ctx)}`);
  console.log('  Listening on loopback only. Press Ctrl+C to stop.\n');

  const tick = () => runAutoBackup(ctx).catch((e) => console.error('Automatic snapshot failed:', e));
  const first = setTimeout(tick, 5000);
  const timer = setInterval(tick, BACKUP_CHECK_MS);

  const noOpen = argv.includes('--no-open') || process.env.RECALL_NO_OPEN === '1';
  if (!config.dev && !noOpen && (argv.includes('--open') || process.stdout.isTTY)) openBrowser(url);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(first);
    clearInterval(timer);
    await close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
